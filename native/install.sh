#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "uso: $0 ID_DA_EXTENSAO [OUTRO_ID...]" >&2
  exit 2
fi

origins=
separator=
for extension_id in "$@"; do
  case "$extension_id" in
    *[!a-p]*|'') echo "ID de extensão inválido: $extension_id" >&2; exit 2 ;;
  esac
  origins="$origins$separator\"chrome-extension://$extension_id/\""
  separator=', '
done

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
extension_dir=$(CDPATH= cd -- "$script_dir/../extension" && pwd)
host_install_dir="$HOME/.local/lib/odoo-xray"
host_path="$host_install_dir/open_in_vscode.py"
manifest_name=com.odoo_xray.editor.json
service_file="$HOME/.config/systemd/user/odoo-xray-bridge.service"
session_type=${XDG_SESSION_TYPE:-}
session_desktop=${XDG_SESSION_DESKTOP:-}
session_backend=${XDG_BACKEND:-}
config_dirs=${XDG_CONFIG_DIRS:-/etc/xdg}

mkdir -p "$host_install_dir"
install -m 755 "$script_dir/open_in_vscode.py" "$host_path"

mkdir -p "$(dirname -- "$service_file")"
printf '%s\n' \
  '[Unit]' \
  'Description=Odoo X-Ray local editor bridge' \
  '' \
  '[Service]' \
  "Environment=XDG_SESSION_TYPE=$session_type" \
  "Environment=XDG_SESSION_DESKTOP=$session_desktop" \
  "Environment=XDG_BACKEND=$session_backend" \
  "Environment=XDG_CONFIG_DIRS=$config_dirs" \
  "ExecStart=/usr/bin/python3 $host_path --serve $*" \
  'Restart=on-failure' \
  '' \
  '[Install]' \
  'WantedBy=default.target' \
  > "$service_file"

install_manifest() {
  target_dir=$1
  mkdir -p "$target_dir"
  printf '%s\n' \
    '{' \
    '  "name": "com.odoo_xray.editor",' \
    '  "description": "Odoo X-Ray VS Code launcher",' \
    "  \"path\": \"$host_path\"," \
    '  "type": "stdio",' \
    "  \"allowed_origins\": [$origins]" \
    '}' > "$target_dir/$manifest_name"
}

install_manifest "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
install_manifest "$HOME/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
install_manifest "$HOME/.config/google-chrome/NativeMessagingHosts"
install_manifest "$HOME/.config/chromium/NativeMessagingHosts"
install_manifest "$HOME/.var/app/com.google.Chrome/config/google-chrome/NativeMessagingHosts"

# Unpacked extensions selected from a Flatpak browser are exposed through the
# document portal. Re-exporting the directory restores that stable portal
# mount after a reboot, so Brave can reload the service worker and content
# scripts that resolve Python and XML source links.
if command -v flatpak >/dev/null 2>&1 &&
   flatpak info com.brave.Browser >/dev/null 2>&1; then
  if ! flatpak document-export --allow-read --app=com.brave.Browser \
      "$extension_dir" >/dev/null; then
    echo "Aviso: não foi possível restaurar o acesso do Brave à extensão." >&2
  fi
fi

systemctl --user daemon-reload
systemctl --user enable odoo-xray-bridge.service
systemctl --user restart odoo-xray-bridge.service

echo "Host nativo instalado para: $*"
echo "Recarregue a extensão e a página do Odoo no navegador."
