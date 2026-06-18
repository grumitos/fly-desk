# Estrategia de pruebas

Fly Desk separa las pruebas por recursos consumidos y por el tipo de contrato que protegen.

## Comandos

- `bun run test:unit`: logica pura y contratos pequenos, sin procesos externos.
- `bun run test:integration`: HTTP, SQLite, filesystem, workers y providers controlados.
- `bun run test:core`: unitarias e integracion en una sola ejecucion Bun.
- `bun run test:ui`: flujos React en Chromium contra el build local.
- `bun run test:coverage`: cobertura de las suites Bun. La cobertura del navegador no se mezcla con este reporte.
- `bun run test`: gate completo de core y UI.

Los archivos Bun deben terminar en `.unit.test.ts` o `.integration.test.ts`. El guard
`test/test-files.unit.test.ts` falla si aparece un `.test.ts` sin clasificar.

## Suite UI

`test/ui.playwright.ts` registra el lifecycle compartido y carga modulos por capacidad desde
`test/ui/`. La suite levanta una instancia del servidor y una de Chromium. Cada caso recibe un
`BrowserContext` nuevo para aislar cookies, storage, rutas y paginas.

Las pruebas UI deben priorizar:

- roles, nombres accesibles y navegacion por teclado
- payloads enviados y estados visibles
- overflow, disponibilidad de controles y cambio de paneles
- flujos criticos de busqueda, resultados, filtros, detalle y cotizacion

Evitar aserciones contra fragmentos de clases Tailwind, jerarquia interna de componentes o
tolerancias subpixel salvo que representen un contrato visual deliberado. Cuando un caso UI falla,
el harness guarda una captura en `test-results/ui/`; CI publica ese directorio como artefacto.

## Cobertura

La cobertura es una senal, no una meta global aislada. Los nuevos casos deben priorizar ramas de:

- seguridad y autenticacion
- orquestacion y contratos de providers
- persistencia, cache, cancelacion y redirects
- conversion de requests compartidos entre frontend y backend

No se eliminan pruebas de compatibilidad `costamar` solo por el nombre legacy: siguen protegiendo
la integracion Click and Book Plus. Antes de retirar una prueba, debe existir evidencia de que el
contrato desaparecio o quedo cubierto por un caso mas directo.
