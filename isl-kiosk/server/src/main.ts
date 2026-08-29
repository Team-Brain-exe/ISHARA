import {
  HandLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "@mediapipe/tasks-vision";
import { flattenLandmarks, matchBest, type Frame, type Reference } from "./dtw";
import { socket } from "./socket";

const video = document.getElementById("video") as HTMLVideoElement;
const canvas = document.getElementById("overlay") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const status = document.getElementById("status")!;
const result = document.getElementById("result")!;
const refListEl = document.getElementById("refList")!;
const labelInput = document.getElementById("labelInput") as HTMLInputElement;
const recordBtn = document.getElementById("recordBtn") as HTMLButtonElement;
const recognizeBtn = document.getElementById("recognizeBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;

// ── Incoming-from-staff panel (created dynamically so we don't need to touch index.html) ──
const incomingPanel = document.createElement("div");
incomingPanel.id = "incomingPanel";
incomingPanel.style.maxWidth = "640px";
incomingPanel.style.margin = "16px auto";
incomingPanel.style.fontSize = "14px";
document.body.appendChild(incomingPanel);

function addIncoming(text: string) {
  const entry = document.createElement("div");
  entry.style.padding = "10px 12px";
  entry.style.marginBottom = "6px";
  entry.style.background = "#131a30";
  entry.style.borderLeft = "4px solid #22d3ee";
  entry.style.borderRadius = "8px";
  entry.textContent = `🔊 Staff said: "${text}"`;
  incomingPanel.prepend(entry);
}

socket.on("turn:new", (turn: { from: string; text: string }) => {
  if (turn.from !== "staff") return;
  addIncoming(turn.text);
  status.textContent = "New response from staff ↓";
});

const STORAGE_KEY = "isl-vision-lab-references";
let references: Reference[] = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");

function renderRefList() {
  if (references.length === 0) {
    refListEl.textContent = "No signs recorded yet.";
    return;
  }
  const counts: Record<string, number> = {};
  for (const r of references) counts[r.label] = (counts[r.label] || 0) + 1;
  refListEl.textContent =
    "Saved signs: " +
    Object.entries(counts).map(([l, c]) => `${l} (${c})`).join(", ");
}
renderRefList();

let isRecording = false;
let isRecognizing = false;
let recordBuffer: Frame[] = [];
let recognizeWindow: Frame[] = [];
const RECOGNIZE_WINDOW_SIZE = 45; // ~1.5s at 30fps
let lastEmittedLabel = "";
let lastEmitTime = 0;

async function setup() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((res) => (video.onloadedmetadata = res));
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  status.textContent = "Loading landmark model…";
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  const handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 1,
  });

  status.textContent = "Live — ready to record or recognize";
  const drawer = new DrawingUtils(ctx);

  function loop() {
    const now = performance.now();
    const res = handLandmarker.detectForVideo(video, now);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let currentFrame: Frame | null = null;

    if (res.landmarks?.length) {
      const landmarks = res.landmarks[0];
      drawer.drawConnectors(landmarks, HandLandmarker.HAND_CONNECTIONS, {
        color: isRecording ? "#f87171" : "#22d3ee",
        lineWidth: 3,
      });
      drawer.drawLandmarks(landmarks, { color: "#f472b6", radius: 3 });
      currentFrame = flattenLandmarks(landmarks);
    }

    if (isRecording && currentFrame) {
      recordBuffer.push(currentFrame);
    }

    if (isRecognizing && currentFrame) {
      recognizeWindow.push(currentFrame);
      if (recognizeWindow.length > RECOGNIZE_WINDOW_SIZE) {
        recognizeWindow.shift();
      }
      if (recognizeWindow.length === RECOGNIZE_WINDOW_SIZE) {
        const best = matchBest(recognizeWindow, references);
        if (best && best.distance < 0.15) {
          result.textContent = `🖐 ${best.label}`;

          // Emit to server — throttled so we don't spam the same label every frame
          const nowMs = Date.now();
          if (best.label !== lastEmittedLabel || nowMs - lastEmitTime > 2000) {
            socket.emit("citizen:sign", { text: best.label });
            lastEmittedLabel = best.label;
            lastEmitTime = nowMs;
          }
        } else {
          result.textContent = "…";
        }
      }
    }

    requestAnimationFrame(loop);
  }
  loop();
}

recordBtn.addEventListener("click", () => {
  const label = labelInput.value.trim();
  if (!label) {
    alert("Type a word first, e.g. 'hello'");
    return;
  }
  if (isRecognizing) stopRecognizing();

  isRecording = true;
  recordBuffer = [];
  recordBtn.disabled = true;
  status.textContent = `Recording "${label}"… sign now!`;

  setTimeout(() => {
    isRecording = false;
    recordBtn.disabled = false;
    if (recordBuffer.length > 5) {
      references.push({ label, sequence: recordBuffer });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(references));
      renderRefList();
      status.textContent = `Saved "${label}" (${recordBuffer.length} frames)`;
    } else {
      status.textContent = "Not enough frames captured — try again, hand must be visible.";
    }
  }, 1500);
});

function startRecognizing() {
  if (references.length === 0) {
    alert("Record at least one sign first.");
    return;
  }
  isRecognizing = true;
  recognizeWindow = [];
  recognizeBtn.disabled = true;
  stopBtn.disabled = false;
  status.textContent = "Recognizing live…";
}

function stopRecognizing() {
  isRecognizing = false;
  recognizeBtn.disabled = false;
  stopBtn.disabled = true;
  result.textContent = "";
  status.textContent = "Stopped recognizing";
}

recognizeBtn.addEventListener("click", startRecognizing);
stopBtn.addEventListener("click", stopRecognizing);

clearBtn.addEventListener("click", () => {
  if (confirm("Clear all saved signs?")) {
    references = [];
    localStorage.removeItem(STORAGE_KEY);
    renderRefList();
  }
});

setup().catch((err) => {
  status.textContent = "Error: " + err.message;
  console.error(err);
});
