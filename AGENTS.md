# Project Rules

## Auto Build and Restart

- After any code change, always rebuild and restart `kube-explorer` automatically.
- Build command:
  - `go build -tags embed -o kube-explorer.exe .`
- Restart command:
  - `Get-Process kube-explorer -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; Start-Process -FilePath .\kube-explorer.exe -ArgumentList "--https-listen-port=0" -WorkingDirectory "."`
- Verify process is running after restart.

## Release Changelog

- Before every version release, update the `README.md` `Changelog` section first.
- Add the new version and release date at the top, and record the main user-facing changes included since the previous tag.
- Do not create or push a release tag until the changelog update has been included in the release commit.
