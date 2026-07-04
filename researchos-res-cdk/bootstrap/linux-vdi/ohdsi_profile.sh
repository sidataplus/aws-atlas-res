#!/usr/bin/env bash
# Optional bootstrap helper for RES Linux VDIs.
# Install this into /etc/profile.d/ohdsi.sh or source it from user shell profiles.

export RESEARCHOS_SSM_PREFIX="${RESEARCHOS_SSM_PREFIX:-/researchos/shared}"
export ATLAS_URL_PARAM="${ATLAS_URL_PARAM:-${RESEARCHOS_SSM_PREFIX}/atlas/url}"
export WEBAPI_URL_PARAM="${WEBAPI_URL_PARAM:-${RESEARCHOS_SSM_PREFIX}/webapi/url}"
export OMOP_ENDPOINT_PARAM="${OMOP_ENDPOINT_PARAM:-${RESEARCHOS_SSM_PREFIX}/omop/endpoint}"
export OMOP_SCHEMAS_PARAM="${OMOP_SCHEMAS_PARAM:-${RESEARCHOS_SSM_PREFIX}/omop/schemas}"

ohdsi-param() {
  aws ssm get-parameter \
    --name "$1" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text
}

ohdsi-env() {
  export ATLAS_URL="$(ohdsi-param "$ATLAS_URL_PARAM")"
  export WEBAPI_URL="$(ohdsi-param "$WEBAPI_URL_PARAM")"
  export OMOP_HOST="$(ohdsi-param "$OMOP_ENDPOINT_PARAM")"
  export OMOP_SCHEMAS_JSON="$(ohdsi-param "$OMOP_SCHEMAS_PARAM")"

  echo "ATLAS_URL=$ATLAS_URL"
  echo "WEBAPI_URL=$WEBAPI_URL"
  echo "OMOP_HOST=$OMOP_HOST"
  echo "OMOP_SCHEMAS_JSON=$OMOP_SCHEMAS_JSON"
}

ohdsi-enable-gdm-autologin() {
  local owner="${1:-${IDEA_SESSION_OWNER:-${USER:-}}}"
  local conf="${GDM_CUSTOM_CONF:-/etc/gdm3/custom.conf}"
  local runner=()

  if [[ -z "$owner" ]]; then
    echo "Usage: ohdsi-enable-gdm-autologin <linux-user>" >&2
    return 2
  fi

  if [[ "$(id -u)" -ne 0 ]]; then
    runner=(sudo)
  fi

  "${runner[@]}" id "$owner" >/dev/null
  "${runner[@]}" cp -a "$conf" "${conf}.ohdsi-autologin.$(date +%Y%m%d%H%M%S).bak"

  "${runner[@]}" python3 - "$owner" "$conf" <<'PY'
import sys
from pathlib import Path

owner = sys.argv[1]
conf = Path(sys.argv[2])
lines = conf.read_text().splitlines()
settings = {
    "WaylandEnable": "false",
    "AutomaticLoginEnable": "true",
    "AutomaticLogin": owner,
}

out = []
in_daemon = False
seen_daemon = False
written = set()

def flush_missing():
    for key, value in settings.items():
        if key not in written:
            out.append(f"{key}={value}")
            written.add(key)

for line in lines:
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        if in_daemon:
            flush_missing()
        in_daemon = stripped == "[daemon]"
        seen_daemon = seen_daemon or in_daemon
        out.append(line)
        continue

    if in_daemon:
        bare = stripped.lstrip("#").strip()
        if "=" in bare:
            key = bare.split("=", 1)[0].strip()
            if key in settings:
                out.append(f"{key}={settings[key]}")
                written.add(key)
                continue

    out.append(line)

if in_daemon:
    flush_missing()
elif not seen_daemon:
    out.extend(["", "[daemon]"])
    flush_missing()

conf.write_text("\n".join(out) + "\n")
PY

  echo "Configured GDM autologin for $owner in $conf"
  echo "Restart gdm3 to apply the change to the active console session."
}

ohdsi-disable-gnome-screen-lock() {
  local owner="${1:-${IDEA_SESSION_OWNER:-${USER:-}}}"
  local uid
  local runner=()

  if [[ -z "$owner" ]]; then
    echo "Usage: ohdsi-disable-gnome-screen-lock <linux-user>" >&2
    return 2
  fi

  if [[ "$(id -u)" -ne 0 ]]; then
    runner=(sudo)
  fi

  uid="$("${runner[@]}" id -u "$owner")"
  "${runner[@]}" loginctl unlock-sessions || true
  "${runner[@]}" runuser -u "$owner" -- env \
    DISPLAY="${DISPLAY:-:0}" \
    XAUTHORITY="${XAUTHORITY:-/run/user/${uid}/gdm/Xauthority}" \
    DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/${uid}/bus}" \
    gsettings set org.gnome.desktop.screensaver lock-enabled false
  "${runner[@]}" runuser -u "$owner" -- env \
    DISPLAY="${DISPLAY:-:0}" \
    XAUTHORITY="${XAUTHORITY:-/run/user/${uid}/gdm/Xauthority}" \
    DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/${uid}/bus}" \
    gsettings set org.gnome.desktop.session idle-delay 0
  "${runner[@]}" runuser -u "$owner" -- env \
    DISPLAY="${DISPLAY:-:0}" \
    XAUTHORITY="${XAUTHORITY:-/run/user/${uid}/gdm/Xauthority}" \
    DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/${uid}/bus}" \
    gsettings set org.gnome.desktop.lockdown disable-lock-screen true

  echo "Disabled GNOME idle and screen lock for $owner"
}
