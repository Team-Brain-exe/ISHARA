"""
FastAPI wrapper around a real OpenHands DecoupledGCN checkpoint, trained on
INCLUDE (Indian Sign Language, isolated word recognition).

This bypasses OpenHands' Hydra/DataModule scaffolding (built for batch dataset
evaluation, not live single-clip serving) and instead:
  1. Reuses OpenHands' own model-construction code (openhands.models.loader)
     and checkpoint, so the network architecture is guaranteed correct.
  2. Reimplements the *preprocessing* pipeline ourselves, matching exactly
     what scripts/mediapipe_extract.py + datasets/pose_transforms.py do at
     training time, verified against the actual OpenHands source.

IMPORTANT CAVEAT: this model recognizes INCLUDE's ~263-word vocabulary
(general Indian Sign Language words like "Afternoon", "Bird", "Doctor") —
NOT your RTO/Aadhar domain vocabulary. Test with an actual INCLUDE word
first to confirm the pipeline works, before judging it on your own signs.
"""
import io
import os
import sys
import tempfile

import cv2
import numpy as np
import pandas as pd
import torch
from fastapi import FastAPI, UploadFile, File
from omegaconf import OmegaConf

# Make the OpenHands submodule importable
OPENHANDS_ROOT = os.environ.get(
    "OPENHANDS_ROOT", os.path.join(os.path.dirname(__file__), "..", "..", "OpenHands")
)
sys.path.insert(0, OPENHANDS_ROOT)
from openhands.models.loader import get_model  # noqa: E402

import mediapipe as mp  # noqa: E402

mp_holistic = mp.solutions.holistic

N_BODY_LANDMARKS = 33
N_HAND_LANDMARKS = 21

# From openhands/datasets/pose_transforms.py — do not change without re-checking source
POSE_SELECT_27 = [0, 2, 5, 11, 12, 13, 14, 33, 37, 38, 41, 42, 45, 46, 49, 50, 53, 54, 58, 59, 62, 63, 66, 67, 70, 71, 74]
SHOULDER_REF_INDEXES = [3, 4]  # positions *within* the reduced 27-point list

CHECKPOINT_DIR = os.environ.get(
    "CHECKPOINT_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "OpenHands", "checkpoints", "slgcn", "include", "sl_gcn")
)
CHECKPOINT_PATH = os.path.join(CHECKPOINT_DIR, "epoch=112-step=12203.ckpt")
CONFIG_PATH = os.path.join(CHECKPOINT_DIR, "config.yaml")
SPLIT_CSV_PATH = os.environ.get(
    "SPLIT_CSV_PATH",
    os.path.join(os.path.dirname(__file__), "..", "..", "OpenHands", "checkpoints", "metadata", "Train_Test_Split", "test_include.csv"),
)


def build_id_to_gloss(split_csv_path: str) -> dict:
    """Rebuilds the exact class-index -> word mapping the model was trained with.
    Must match openhands.datasets.isolated.base.BaseIsolatedDataset.read_glosses()
    exactly: sorted(unique "Word" values), enumerated in that order.
    """
    df = pd.read_csv(split_csv_path)
    glosses = sorted(set(df["Word"]))
    return {i: gloss for i, gloss in enumerate(glosses)}


class HolisticExtractor:
    """Wraps mediapipe Holistic, matching scripts/mediapipe_extract.py's
    process_body_landmarks / process_other_landmarks behavior exactly
    (zero-fill when a component isn't detected in a frame)."""

    def __init__(self):
        self.holistic = mp_holistic.Holistic(static_image_mode=False, model_complexity=2)

    def close(self):
        self.holistic.close()

    def _landmarks_to_array(self, component, n_points):
        if component is None:
            return np.zeros((n_points, 3))
        return np.array([[p.x, p.y, p.z] for p in component.landmark])

    def extract(self, frames_rgb: np.ndarray) -> np.ndarray:
        """frames_rgb: (T, H, W, 3) uint8, RGB order.
        Returns: (T, 75, 3) float array = [body(33), left_hand(21), right_hand(21)],
        matching gen_keypoints_for_frames' body_kps slicing exactly."""
        out = []
        for frame in frames_rgb:
            results = self.holistic.process(frame)
            body = self._landmarks_to_array(results.pose_landmarks, N_BODY_LANDMARKS)
            lh = self._landmarks_to_array(results.left_hand_landmarks, N_HAND_LANDMARKS)
            rh = self._landmarks_to_array(results.right_hand_landmarks, N_HAND_LANDMARKS)
            out.append(np.concatenate([body, lh, rh], axis=0))  # (75, 3)
        return np.stack(out, axis=0)  # (T, 75, 3)


def preprocess_clip(video_path: str, extractor: HolisticExtractor) -> torch.Tensor:
    """Video file -> model input tensor (1, C=2, T, V=27), replicating the
    exact training-time preprocessing (PoseSelect + CenterAndScaleNormalize,
    no augmentations — those only run in the train_pipeline, not test)."""
    frames = []
    cap = cv2.VideoCapture(video_path)
    while cap.isOpened():
        ok, img = cap.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    cap.release()
    if len(frames) == 0:
        raise ValueError("No frames decoded from clip")
    frames = np.asarray(frames)

    kps75 = extractor.extract(frames)          # (T, 75, 3)
    kps27 = kps75[:, POSE_SELECT_27, :]        # (T, 27, 3)  -- PoseSelect
    kps27_2d = kps27[:, :, :2]                 # drop z       -- pose_use_z_axis=False

    x = torch.tensor(kps27_2d, dtype=torch.float32).permute(2, 0, 1)  # (C=2, T, V=27)

    # CenterAndScaleNormalize, clip-level (frame_level=False), scale_factor=1
    C, T, V = x.shape
    xtvc = x.permute(1, 2, 0)  # (T, V, C)
    i1, i2 = SHOULDER_REF_INDEXES
    p1, p2 = xtvc[:, i1, :], xtvc[:, i2, :]     # (T, C) each
    center = torch.mean((p1 + p2) / 2, dim=0)   # (C,)
    mean_dist = torch.mean(torch.sqrt(((p1 - p2) ** 2).sum(-1)))
    scale = 1.0 / mean_dist if torch.isfinite(mean_dist) and mean_dist > 0 else 1.0
    xtvc = (xtvc - center) * scale
    x = xtvc.permute(2, 0, 1)  # back to (C, T, V)

    return x.unsqueeze(0)  # (1, C, T, V) — batch of 1


class ModelWrapper(torch.nn.Module):
    """Mirrors InferenceModel's `self.model = ...` attribute name so the
    checkpoint's state_dict keys (saved as 'model.xxx') load without
    needing manual key remapping."""
    def __init__(self, model_cfg, in_channels, num_class):
        super().__init__()
        self.model = get_model(model_cfg, in_channels, num_class)

    def forward(self, x):
        return self.model(x)


app = FastAPI()
_extractor: HolisticExtractor | None = None
_model: ModelWrapper | None = None
_id_to_gloss: dict | None = None
_device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")


@app.on_event("startup")
def load_everything():
    global _extractor, _model, _id_to_gloss

    print(f"Loading id_to_gloss from {SPLIT_CSV_PATH} ...")
    _id_to_gloss = build_id_to_gloss(SPLIT_CSV_PATH)
    num_class = len(_id_to_gloss)
    print(f"  -> {num_class} classes")

    print(f"Loading config from {CONFIG_PATH} ...")
    cfg = OmegaConf.load(CONFIG_PATH)

    print("Building model (in_channels=2, matching pose_use_z_axis=False, pose_use_confidence_scores=False) ...")
    model = ModelWrapper(cfg.model, in_channels=2, num_class=num_class)

    print(f"Loading checkpoint from {CHECKPOINT_PATH} ...")
    ckpt = torch.load(CHECKPOINT_PATH, map_location="cpu", weights_only=False)
    result = model.load_state_dict(ckpt["state_dict"], strict=False)
    print(f"  missing_keys={len(result.missing_keys)} unexpected_keys={len(result.unexpected_keys)}")
    if result.missing_keys:
        print("  WARNING missing:", result.missing_keys[:10])
    if result.unexpected_keys:
        print("  WARNING unexpected:", result.unexpected_keys[:10])
    # If missing_keys is large (close to total param count), the checkpoint
    # did NOT actually load — the model would be randomly initialized and
    # every prediction meaningless. A handful of missing/unexpected buffer
    # keys is normal; most of the network's weights should be present.

    model.to(_device).eval()
    _model = model
    _extractor = HolisticExtractor()
    print("Model service ready.")


@app.get("/health")
def health():
    return {"ok": _model is not None, "num_classes": len(_id_to_gloss) if _id_to_gloss else 0}


@app.post("/predict")
async def predict(file: UploadFile = File(...)):
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        x = preprocess_clip(tmp_path, _extractor).to(_device)
        with torch.no_grad():
            logits = _model(x)
            probs = torch.softmax(logits, dim=-1)[0]
            pred_index = int(torch.argmax(probs).item())
            confidence = float(probs[pred_index].item())
        label = _id_to_gloss[pred_index]
        return {"predictions": [label], "confidence": confidence}
    finally:
        os.unlink(tmp_path)
