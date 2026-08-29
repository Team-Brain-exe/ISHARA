import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";

// ── In-memory session/context engine ───────────────────────
// MVP: a single active session, per your 5-week scope.
// Later: keyed by kiosk/counter ID for multiple simultaneous sessions.

type Domain = "RTO" | "Aadhar" | "PAN" | "General";

interface Turn {
  id: string;
  from: "citizen" | "staff";
  text: string;
  timestamp: number;
}

interface Session {
  domain: Domain;
  turns: Turn[];
}

let session: Session = {
  domain: "RTO",
  turns: [],
};

function resetSession(domain: Domain = "RTO") {
  session = { domain, turns: [] };
}

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }, // fine for local dev; lock down before deploying
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, session });
});

io.on("connection", (socket) => {
  console.log("client connected:", socket.id);

  // Send current session state to whoever just joined (citizen or staff screen)
  socket.emit("session:sync", session);

  // Citizen screen recognized a sign → broadcast to staff screen
  socket.on("citizen:sign", (payload: { text: string }) => {
    const turn: Turn = {
      id: crypto.randomUUID(),
      from: "citizen",
      text: payload.text,
      timestamp: Date.now(),
    };
    session.turns.push(turn);
    io.emit("turn:new", turn); // both screens receive it
  });

  // Staff sent a spoken response → broadcast to citizen screen
  socket.on("staff:response", (payload: { text: string }) => {
    const turn: Turn = {
      id: crypto.randomUUID(),
      from: "staff",
      text: payload.text,
      timestamp: Date.now(),
    };
    session.turns.push(turn);
    io.emit("turn:new", turn);
  });

  // Staff switches domain pack mid-session
  socket.on("session:setDomain", (payload: { domain: Domain }) => {
    session.domain = payload.domain;
    io.emit("session:sync", session);
  });

  // End session, reset for next citizen
  socket.on("session:end", () => {
    resetSession(session.domain);
    io.emit("session:sync", session);
  });

  socket.on("disconnect", () => {
    console.log("client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`Session server running on http://localhost:${PORT}`);
});
