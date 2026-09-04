import {
  HandLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "@mediapipe/tasks-vision";
import { flattenLandmarks, matchBest, type Frame, type Reference } from "./dtw";
import { Segmenter } from "./segmenter";
import { socket, SERVER_URL } from "./socket";

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

const incomingPanel = document.getElementById("incomingPanel")!;

function addIncoming(text: string) {
  const emptyState = document.getElementById("emptyState");
  if (emptyState) emptyState.remove();
  const entry = document.createElement("div");
  entry.className = "incoming-entry";
  entry.textContent = `🔊 Staff said: "${text}"`;
  incomingPanel.prepend(entry);
}

socket.on("turn:new", (turn: { from: string; text: string }) => {
  if (turn.from !== "staff") return;
  addIncoming(turn.text);
  status.textContent = "New response from staff →";
});

const STORAGE_KEY = "isl-vision-lab-references-v2"; // v2: two-hand, normalized frames — old v1 data isn't compatible
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

let isArmedToRecord = false;
let isRecognizing = false;
let pendingLabel = "";
let currentFrame: Frame | null = null;

const recognizeSegmenter = new Segmenter(
  () => { status.textContent = "Signing detected — tracking…"; },
  (frames) => {
    if (frames.length < 4) return;
    const best = matchBest(frames, references);
    if (best && best.distance < 0.6) {
      result.textContent = `🖐 ${best.label}`;
      socket.emit("citizen:sign", { text: best.label });
      status.textContent = "Recognizing live…";
    } else {
      result.textContent = "…not sure, try again";
      status.textContent = "Recognizing live…";
    }
  }
);

const recordSegmenter = new Segmenter(
  () => { status.textContent = `Recording "${pendingLabel}"… sign now!`; },
  (frames) => {
    isArmedToRecord = false;
    recordBtn.disabled = false;
    if (frames.length >= 4) {
      references.push({ label: pendingLabel, sequence: frames });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(references));
      renderRefList();
      status.textContent = `Saved "${pendingLabel}" (${frames.length} frames)`;
    } else {
      status.textContent = "Not enough motion captured — try again, hand must be visible.";
    }
  },
  { stillFramesToEnd: 8 }
);

async function setup() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: 640,
      height: 480,
      frameRate: { ideal: 60, min: 30 },
    },
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
    numHands: 2,
  });

  status.textContent = "Live — ready to record or recognize";
  const drawer = new DrawingUtils(ctx);

  function loop() {
    const now = performance.now();
    const res = handLandmarker.detectForVideo(video, now);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    currentFrame = null;

    if (res.landmarks?.length) {
      for (const landmarks of res.landmarks) {
        drawer.drawConnectors(landmarks, HandLandmarker.HAND_CONNECTIONS, {
          color: isArmedToRecord ? "#f87171" : "#22d3ee",
          lineWidth: 3,
        });
        drawer.drawLandmarks(landmarks, { color: "#f472b6", radius: 3 });
      }
      currentFrame = flattenLandmarks(res.landmarks);
    }

    if (isArmedToRecord) recordSegmenter.push(currentFrame);
    if (isRecognizing) recognizeSegmenter.push(currentFrame);

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

  pendingLabel = label;
  isArmedToRecord = true;
  recordBtn.disabled = true;
  recordSegmenter.reset();
  status.textContent = `Ready — sign "${label}" whenever you like`;
});

function startRecognizing() {
  if (references.length === 0) {
    alert("Record at least one sign first.");
    return;
  }
  isRecognizing = true;
  recognizeSegmenter.reset();
  recognizeBtn.disabled = true;
  stopBtn.disabled = false;
  status.textContent = "Recognizing live…";
}

function stopRecognizing() {
  isRecognizing = false;
  recognizeSegmenter.reset();
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

const mlBtn = document.createElement("button");
mlBtn.textContent = "🤖 ML Recognize";
mlBtn.style.marginLeft = "8px";
recognizeBtn.insertAdjacentElement("afterend", mlBtn);

let mlBusy = false;

function recordAndSendClip(): Promise<{ predicted: string; raw: string } | null> {
  return new Promise((resolve) => {
    const stream = video.srcObject as MediaStream;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const clipSegmenter = new Segmenter(
      () => { status.textContent = "Motion detected — recording clip…"; },
      async (frames) => {
        clipSegmenter.reset();
        clearTimeout(noMotionTimer);
        setTimeout(() => recorder.stop(), 200);
        void frames;
      }
    );

    const noMotionTimer = setTimeout(() => {
      status.textContent = "No signing detected — try again";
      recorder.stop();
    }, 6000);

    const stopped = new Promise<void>((res) => { recorder.onstop = () => res(); });

    status.textContent = "Waiting for you to start signing…";
    recorder.start();

    const watcher = setInterval(() => clipSegmenter.push(currentFrame), 1000 / 30);

    stopped.then(async () => {
      clearInterval(watcher);
      clearTimeout(noMotionTimer);

      const blob = new Blob(chunks, { type: "video/webm" });
      if (blob.size === 0) { resolve(null); return; }

      const formData = new FormData();
      formData.append("video", blob, "clip.webm");

      status.textContent = "Sending to model…";
      try {
        const res = await fetch(`${SERVER_URL}/recognize`, { method: "POST", body: formData });
        const data = await res.json();
        if (data.ok) {
          result.textContent = `🖐 ${data.turn.text}`;
          status.textContent = `Model prediction: ${data.raw}`;
          resolve({ predicted: data.turn.text, raw: data.raw });
        } else {
          status.textContent = "Recognition failed: " + (data.error || "unknown error");
          resolve(null);
        }
      } catch (err) {
        status.textContent = "Network error sending clip";
        console.error(err);
        resolve(null);
      }
    });
  });
}

mlBtn.addEventListener("click", async () => {
  if (mlBusy) return;
  mlBusy = true;
  mlBtn.disabled = true;
  const outcome = await recordAndSendClip();
  mlBusy = false;
  mlBtn.disabled = false;

  const expected = expectedWordInput.value.trim();
  if (expected && outcome?.predicted) {
    logTestResult(expected, outcome.predicted);
  }
});

const testPanel = document.createElement("div");
testPanel.style.maxWidth = "480px";
testPanel.style.margin = "20px auto";
testPanel.style.padding = "16px";
testPanel.style.background = "#131a30";
testPanel.style.borderRadius = "10px";
testPanel.style.fontSize = "14px";

testPanel.innerHTML = `
  <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
    <input id="expectedWordInput" placeholder="word you're about to sign, e.g. Hello"
      style="flex:1; padding:8px; border-radius:6px; border:none;" />
  </div>
  <div id="testStats" style="margin-bottom:10px; opacity:0.8;">No tests yet.</div>
  <div id="testLog" style="max-height:300px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;"></div>
`;
document.body.appendChild(testPanel);

const expectedWordInput = document.getElementById("expectedWordInput") as HTMLInputElement;
const testStats = document.getElementById("testStats")!;
const testLog = document.getElementById("testLog")!;

let testResults: { expected: string; predicted: string; match: boolean }[] = [];

function renderTestStats() {
  const total = testResults.length;
  const correct = testResults.filter((r) => r.match).length;
  testStats.textContent = total === 0
    ? "No tests yet."
    : `${correct}/${total} correct (${Math.round((correct / total) * 100)}%)`;
}

function logTestResult(expected: string, predicted: string) {
  const match = predicted.toLowerCase().includes(expected.toLowerCase()) ||
                expected.toLowerCase().includes(predicted.toLowerCase());
  testResults.push({ expected, predicted, match });
  renderTestStats();

  const entry = document.createElement("div");
  entry.style.padding = "8px 10px";
  entry.style.borderRadius = "6px";
  entry.style.background = match ? "#0f3d2e" : "#3d0f0f";
  entry.style.borderLeft = match ? "4px solid #22c55e" : "4px solid #ef4444";
  entry.textContent = `${match ? "✅" : "❌"} expected: "${expected}" → predicted: "${predicted}"`;
  testLog.prepend(entry);
}
