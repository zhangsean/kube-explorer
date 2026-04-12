# Project Rules

## Auto Build and Restart

- After any code change, always rebuild and restart `kube-explorer` automatically.
- Build command:
  - `go build -tags embed -o kube-explorer.exe .`
- Restart command:
  - `Get-Process kube-explorer -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; Start-Process -FilePath .\kube-explorer.exe -ArgumentList "--https-listen-port=0" -WorkingDirectory "."`
- Verify process is running after restart.
