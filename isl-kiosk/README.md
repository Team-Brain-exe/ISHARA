# ISL Kiosk Monorepo

apps/vision-lab  - citizen-facing: webcam capture, MediaPipe hand-landmark tracking,
                    local DTW sign matching + real ML model recognition via server
apps/voice-lab   - staff-facing: mic input, speech transcript, two-way transcript panel
server           - session/context engine (Socket.IO) + /recognize proxy to the ISL model service
