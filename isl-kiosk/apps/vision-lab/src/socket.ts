import { io } from "socket.io-client";

const SERVER_URL = "https://glowing-space-fortnight-x5q56vx9xgjqc6rr9-4000.app.github.dev";

export const socket = io(SERVER_URL);

socket.on("connect", () => console.log("vision-lab connected:", socket.id));
socket.on("connect_error", (err) => console.error("connection failed:", err.message));
