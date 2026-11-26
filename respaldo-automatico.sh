#!/bin/zsh
# Lo corre launchd una vez por día (12:45, o al despertar). Registro solo con fechas y conteos.
# Si falla 3 veces seguidas, avisa con una notificación.
AQUI="${0:A:h}"
LOG="$HOME/Library/Logs/garage-respaldo.log"
FALLAS="$HOME/Library/Logs/garage-respaldo.fallas"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "${LOG:h}"
{
  echo "=== $(date '+%Y-%m-%d %H:%M')"
  if node "$AQUI/respaldo-firestore.mjs" </dev/null; then
    rm -f "$FALLAS"
  else
    n=$(( $(cat "$FALLAS" 2>/dev/null || echo 0) + 1 ))
    echo $n > "$FALLAS"
    if (( n == 3 )); then
      osascript -e 'display notification "No se pudo respaldar Garage Radar (3 veces seguidas). Mirá ~/Library/Logs/garage-respaldo.log" with title "Garage Radar" sound name "Basso"' >/dev/null 2>&1
    fi
  fi
} >> "$LOG" 2>&1
[[ -f "$LOG" ]] && { tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; }
