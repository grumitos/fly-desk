# AGENTS

Guia para agentes que trabajen en Fly Desk.

## Reglas obligatorias

1. Lee primero `README.md`, `docs/REPO_CURRENT_STATE.md`, `docs/DEPLOY_APP.md` y `docs/FRONTEND_IDENTITY.md`.
2. No imprimas ni guardes secretos. Esto incluye `.env`, cookies, tokens, passwords, TOTP/otpauth, subscription keys, API tokens y sesiones de navegador.
3. No tocar `D:\Dev\VPS\fly-desk\test\ui.playwright.ts` salvo instruccion explicita del mantenedor; contiene trabajo paralelo local.
4. Este repo cambia producto, backend, frontend, CI y deploy propio de Fly Desk. Caddy, systemd compartido, firewall, certificados, geofence y mantenimiento diario pertenecen a `D:\Dev\VPS\vps-platform`.
5. El package manager soportado es Bun. No agregar `package-lock.json`, `pnpm-lock.yaml` ni `yarn.lock`.
6. El deploy de app debe reiniciar solo `fly-desk.service` y conservar `fly-desk-chrome.service` salvo instruccion explicita.

## Verificacion

Para cambios de codigo o runtime:

```powershell
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
```

Para cambios solo documentales:

```powershell
git diff --check
rg -n "\]\([^)]*\.md\)" README.md docs frontend/README.md AGENTS.md
```
