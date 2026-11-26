#!/bin/zsh
# Activa el respaldo diario de Firestore (12:45, o al despertar). Para desactivarlo:
#   launchctl bootout gui/$UID ~/Library/LaunchAgents/com.drbac91.garage-respaldo.plist
set -eu
AQUI="${0:A:h}"
DEST="$HOME/Library/LaunchAgents/com.drbac91.garage-respaldo.plist"
security find-generic-password -s garage-firestore -a "$USER" >/dev/null 2>&1 \
  || { echo "Primero guardá la clave en el Llavero (ver README, «Respaldo automático de Firestore»)."; exit 1; }
mkdir -p "${DEST:h}"
sed "s|__AQUI__|$AQUI|" "$AQUI/com.drbac91.garage-respaldo.plist" > "$DEST"
plutil -lint -s "$DEST"
launchctl bootout "gui/$UID" "$DEST" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$DEST"
echo "Respaldo activado (12:45). Registro: ~/Library/Logs/garage-respaldo.log"
