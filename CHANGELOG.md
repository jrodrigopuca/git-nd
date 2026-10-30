# Changelog

Todos los cambios relevantes de git-nd. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa
[versionado semántico](https://semver.org/lang/es/).

Qué cubre el número de versión: la API REST la usa solo la propia interfaz, así
que no es un contrato público. Lo que una versión mayor promete no romper son
los **datos que git-nd guarda en disco** (`~/.git-nd`: tokens cifrados,
configuración) y su **comportamiento sobre los repositorios**.

## [1.0.0] - 2026-10-30

Primera versión publicada. Reúne todo lo construido hasta acá; el detalle de
cada bug corregido, con el test que lo prueba, está en [BACKLOG.md](BACKLOG.md).

### Plataformas y requisitos

- Node 24 o superior.
- Probado en **macOS** (desarrollo y E2E) y **Linux** (CI), con **Google
  Chrome**. **Windows no está probado.**
- No necesita el binario `git`: usa isomorphic-git sobre el sistema de
  archivos real.

### Funcionalidades

- **Tres vistas**: Explorer (recientes, navegador de carpetas, clonar desde
  una URL, repos remotos), Repository (el área de trabajo) y Connections
  (cuentas de GitHub y GitLab).
- **Abrir y clonar** repositorios locales y remotos por HTTP(S). El diálogo de
  clone muestra la carpeta destino antes de clonar; las rutas relativas van
  debajo de `~/git-nd-repos`.
- **Cambios y commits**: stage, unstage y discard por archivo o por hunk;
  commit con autor editable; amend; stage/unstage de todo; los commits vacíos
  se bloquean.
- **Identidad del autor al estilo git**: `.git/config` del repo → cuenta del
  provider que coincide con el origin → default de la app.
- **Ramas y tags**: crear, cambiar, borrar, mergear; checkout de una rama
  remota crea la local correspondiente; tags desde cualquier commit.
- **Historial y grafo**: grafo SVG de todas las ramas con etiquetas, hash y
  fecha relativa; desde un commit, revert seguro, cherry-pick, tag o hard
  reset.
- **Sincronización**: push, pull (merge o rebase), fetch manual y automático
  cada 2 minutos, indicadores ahead/behind.
- **Merge y conflictos**: vista Merge con el progreso, los archivos y los
  commits entrantes; editor visual por conflicto (Keep local / Take incoming /
  Both / Edit) y modo texto.
- **Editor de archivos** con detección de cambios externos: recarga si no hay
  cambios sin guardar, avisa si los hay.
- **GitHub y GitLab**: conectar por personal access token u OAuth, listar
  repos, crear y listar PRs/MRs con vista previa de commits y archivos, issues.
  Los GitLab self-hosted se configuran con `GITLAB_URL`.
- **Refresco en vivo**: un watcher sincroniza la UI con lo que se hace en el
  editor o en una terminal.
- **Stash**: guardar, aplicar, pop.

### Repositorios grandes

- El grafo se carga por páginas desde un único recorrido ordenado por fecha y
  solo dibuja las filas visibles; un refresco sin cambios de ramas no lo
  redibuja. Probado con 14k commits y 259 ramas
  ([ADR-0001](docs/adr/0001-carga-del-grafo-en-repos-grandes.md)).
- Cache de isomorphic-git compartida por repo abierto: en ese repo, leer el
  historial de las 259 ramas pasó de 41,8 s a 2,5 s.
- Ahead/behind y pull --rebase siguen el grafo real: antes fallaban con más de
  300 commits de diferencia.

### Seguridad

- Los tokens nunca llegan al navegador: se guardan cifrados con AES-256-GCM en
  `~/.git-nd/tokens.enc`.
- Un token solo se envía al host **exacto** de su provider y por **https**,
  según la URL que realmente se pide; un proxy configurado por el repo no ve el
  tráfico.
- La API solo responde a la propia página: verificación de `Host`, `Origin`,
  `Sec-Fetch-Site` y el header `X-GitND`, también para el WebSocket.
- Las rutas que vienen de un repo no pueden salir de él ni tocar `.git/`, ni
  siquiera a través de symlinks.

### Integridad de datos

- Un merge nunca pisa trabajo sin commitear.
- Discard restaura desde el index, y el stage por hunk respeta los bytes
  exactos (BOM, archivos sin salto de línea final, archivos nuevos).
- El merge en curso se guarda en `.git/MERGE_HEAD` como lo hace git:
  sobrevive a un reinicio y coincide con la CLI.
- Un clone fallido borra solo lo que creó.
- La UI nunca muestra ni actúa sobre datos de otro repo o de una respuesta
  vieja.

### Accesibilidad y diseño

- Todo es operable con teclado: árbol, grafo (flechas), listas y modales; el
  foco es visible.
- Contraste WCAG AA en los temas claro y oscuro, verificado por un test.
- Íconos SVG propios (Lucide y Simple Icons, servidos localmente) en lugar de
  emojis; marca y favicon nuevos.
- Panel de commit al estilo GitHub Desktop: el botón dice qué va a commitear o
  por qué no puede.
- Sidebar Files colapsable para darle espacio al grafo; en ventanas angostas,
  Changes y Commit pasan a un panel desplegable.
- Connections y Explorer rediseñados: ayuda de scopes para el token, errores
  junto al campo, recientes por nombre, un solo botón principal por vista.

### Calidad

- 107 tests unitarios, de servicio y HTTP (`pnpm test`), en CI en cada push a
  `main`.
- 68 tests end-to-end con Playwright (`pnpm e2e`), a demanda.
- Los tests usan un `HOME` y repos temporales: nunca tocan los datos del
  usuario.

### Documentación

- [Arquitectura](docs/architecture.md) y [flujos con diagramas de
  secuencia](docs/flows.md), en español, junto con el README.

### Limitaciones conocidas

- Windows no está probado.
- El favicon toma el color del tema del sistema en Chrome; en Safari no está
  verificado.
- Diferencias con git que conviene conocer (sección "Para evaluar" de
  [BACKLOG.md](BACKLOG.md)):
  - borrar una rama sin mergear no avisa, como sí lo hace `git branch -d`, y no
    hay reflog para recuperarla;
  - amend y cherry-pick ponen la fecha actual como fecha del autor; git la
    conserva;
  - rebase y cherry-pick no conservan el modo de los archivos ni los symlinks;
  - un archivo untracked bloquea cherry-pick, revert y pull --rebase, más
    estricto que git.
- Abiertos: al arrancar sin repo, la app puede llevar a Explorer aunque ya se
  haya elegido otra vista (B-27), y dos reportes del grafo todavía sin
  reproducir (B-25, B-26).

[1.0.0]: https://github.com/jrodrigopuca/git-nd/releases/tag/v1.0.0
