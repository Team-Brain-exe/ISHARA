# ISL Kiosk Monorepo

apps/citizen     - citizen-facing screen (from ISL_Speech_Translator_Kiosk.zip)
apps/staff       - staff-facing screen (from Staff-Facing_Screen_Design.zip)
apps/vision-lab  - Step 1: standalone webcam + landmark-extraction test harness
packages/shared-types - shared TS types (Session, Domain, RecognizedTurn)
packages/shared-ui    - shared components (domain-pack badge, transcript row, mic button, avatar frame)
server           - session/context engine + ASR/translation/TTS endpoints
