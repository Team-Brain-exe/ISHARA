import { socket } from "./socket";

const micBtn = document.getElementById("micBtn") as HTMLButtonElement;
const status = document.getElementById("status")!;
const transcriptEl = document.getElementById("transcript")!;
const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
const editBtn = document.getElementById("editBtn") as HTMLButtonElement;
const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;
const sentLog = document.getElementById("sentLog")!;
const incomingPanel = document.getElementById("incomingPanel")!;

const SpeechRecognitionCtor =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

if (!SpeechRecognitionCtor) {
  status.textContent = "Your browser doesn't support Web Speech API — try Chrome.";
  micBtn.disabled = true;
}

let recognition: any = null;
let isListening = false;
let finalText = "";

function setupRecognition() {
  recognition = new SpeechRecognitionCtor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-IN";

  recognition.onresult = (event: any) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        finalText += res[0].transcript + " ";
      } else {
        interim += res[0].transcript;
      }
    }
    updateTranscript(finalText, interim);
  };

  recognition.onerror = (event: any) => {
    status.textContent = "Error: " + event.error;
  };

  recognition.onend = () => {
    if (isListening) recognition.start();
  };
}

function updateTranscript(final: string, interim: string) {
  if (final.trim() || interim.trim()) {
    transcriptEl.innerHTML =
      escapeHtml(final) +
      (interim ? `<span style="opacity:0.5;font-style:italic">${escapeHtml(interim)}</span>` : "");
  } else {
    transcriptEl.textContent = "…";
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

micBtn.addEventListener("click", () => {
  if (!recognition) setupRecognition();
  if (!isListening) {
    isListening = true;
    micBtn.classList.add("listening");
    status.textContent = "Listening… speak now";
    recognition.start();
  } else {
    isListening = false;
    micBtn.classList.remove("listening");
    status.textContent = "Stopped — review and send, or tap mic to continue";
    recognition.stop();
  }
});

editBtn.addEventListener("click", () => {
  const current = finalText.trim();
  const edited = prompt("Edit transcription before sending:", current);
  if (edited !== null) {
    finalText = edited + " ";
    updateTranscript(finalText, "");
  }
});

sendBtn.addEventListener("click", () => {
  const text = finalText.trim();
  if (!text) {
    alert("Nothing to send yet — speak first.");
    return;
  }
  socket.emit("staff:response", { text });

  const entry = document.createElement("div");
  entry.textContent = `📤 Sent to citizen: "${text}"`;
  sentLog.prepend(entry);

  finalText = "";
  updateTranscript("", "");
  status.textContent = "Sent. Ready for next response.";
});

clearBtn.addEventListener("click", () => {
  finalText = "";
  updateTranscript("", "");
  status.textContent = "Cleared";
});

socket.on("turn:new", (turn: { from: string; text: string }) => {
  if (turn.from !== "citizen") return;
  const emptyState = document.getElementById("emptyState");
  if (emptyState) emptyState.remove();
  const entry = document.createElement("div");
  entry.className = "incoming-entry";
  entry.textContent = `🖐 ${turn.text}`;
  incomingPanel.prepend(entry);
  status.textContent = "New message from citizen ←";
});

socket.on("session:sync", (session: { domain: string; turns: any[] }) => {
  console.log("session synced:", session);
});
