import { io } from "socket.io-client";

const SERVER_URL = "http://localhost:4000";

export const socket = io(SERVER_URL);

socket.on("connect", () => console.log("vision-lab connected:", socket.id));
socket.on("connect_error", (err) => console.error("connection failed:", err.message));
