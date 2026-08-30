import {
  HandLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "@mediapipe/tasks-vision";
import { flattenLandmarks, matchBest, type Frame, type Reference } from "./dtw";
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
const RECOGNIZE_WINDOW_SIZE = 45;
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

// --- ML recognition using the real trained ISL model, via the Node server ---
const mlBtn = document.createElement("button");
mlBtn.textContent = "🤖 ML Recognize (2s clip)";
mlBtn.style.marginLeft = "8px";
recognizeBtn.insertAdjacentElement("afterend", mlBtn);

let mlBusy = false;

async function recordAndSendClip() {
  const stream = video.srcObject as MediaStream;
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });

  status.textContent = "Recording 2s clip for the model…";
  recorder.start();
  await new Promise((r) => setTimeout(r, 2000));
  recorder.stop();
  await stopped;

  const blob = new Blob(chunks, { type: "video/webm" });
  const formData = new FormData();
  formData.append("video", blob, "clip.webm");

  status.textContent = "Sending to model…";
  try {
    const res = await fetch(`${SERVER_URL}/recognize`, { method: "POST", body: formData });
    const data = await res.json();
    if (data.ok) {
      result.textContent = `🖐 ${data.turn.text}`;
      status.textContent = `Model prediction: ${data.raw}`;
    } else {
      status.textContent = "Recognition failed: " + (data.error || "unknown error");
    }
  } catch (err) {
    status.textContent = "Network error sending clip";
    console.error(err);
  }
}

mlBtn.addEventListener("click", async () => {
  if (mlBusy) return;
  mlBusy = true;
  mlBtn.disabled = true;
  await recordAndSendClip();
  mlBusy = false;
  mlBtn.disabled = false;
});

// --- Word testing panel: track expected vs predicted for building your demo shortlist ---
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

// Wrap the existing ML recognize flow to also log the result against the expected word
const originalMlBtnHandler = mlBtn.onclick;
mlBtn.addEventListener("click", async () => {
  const expected = expectedWordInput.value.trim();
  // Wait for recordAndSendClip's result to land in `status`/`result`, then log it
  setTimeout(() => {
    const predicted = result.textContent?.replace("🖐 ", "").trim() || "";
    if (expected && predicted) {
      logTestResult(expected, predicted);
    }
  }, 2500); // slightly after the 2s recording + network round trip
});
