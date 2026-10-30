# git-nd

Cliente Git local con interfaz web. Corre en `http://localhost:3847` y maneja repositorios reales en disco con [isomorphic-git](https://isomorphic-git.org/) del lado del servidor (Node + Express): no hace falta el binario `git`.

**Documentación**

- [Arquitectura](docs/architecture.md): componentes, dónde vive el estado, límites de confianza, reglas de consistencia, eventos
- [Cómo funciona](docs/flows.md): diagramas de secuencia de abrir un repo, cambios externos, commit, push y tokens, conflictos de merge, el grafo paginado, conectar una cuenta, clonar
- [Registros de decisiones](docs/adr/README.md): las decisiones caras de revertir, y por qué se tomaron
- [CHANGELOG.md](CHANGELOG.md): qué trae cada versión, plataformas probadas y limitaciones conocidas
- [BACKLOG.md](BACKLOG.md): bugs conocidos, sus fixes y el test que prueba cada uno

## Inicio rápido

```bash
pnpm install
pnpm start
# → http://localhost:3847
```

Para desarrollo con recarga automática: `pnpm dev`. Requiere Node ≥ 24.

## Tests

| Comando | Qué | Cuándo |
| --- | --- | --- |
| `pnpm test` | Tests unitarios, de servicio y HTTP (`test/`, `node:test`) | CI en cada push a `main` (`.github/workflows/ci.yml`) |
| `pnpm e2e` | E2E en el navegador con Playwright (`e2e/`) sobre el Google Chrome instalado | A demanda, en local o con el botón "Run workflow" del workflow **E2E** |

Los dos arman sus repositorios con la CLI de `git` (la app nunca la necesita) en carpetas temporales y con un `HOME` temporal: nunca tocan los repos, la configuración ni los tokens del usuario. Los bugs conocidos y sus tests están en [BACKLOG.md](BACKLOG.md).

## Funcionalidades

La app se organiza en tres vistas (barra de actividad a la izquierda, al estilo de un IDE):

- **Explorer**: repositorios recientes (por nombre, con el abierto marcado), un navegador de carpetas que lista primero los repos Git, clonar desde una URL y los repos remotos de GitHub/GitLab listos para clonar
- **Repository**: la vista de trabajo: árbol de archivos (colapsable para darle espacio al grafo), editor, diffs, grafo, cambios, ramas, historial, stash, PRs
- **Connections**: una tarjeta por provider: conectar con un personal access token (se muestran los scopes que necesita y un link para crearlo) u OAuth, ver con qué cuenta se está conectado, desconectar

Además:

- **Abrir / clonar** repositorios locales o remotos (HTTP/HTTPS)
- **Árbol de archivos** con carga diferida, íconos por tipo de archivo, indicadores de estado (M/U/D/!) y drag & drop para agregar archivos
- **Editor de archivos**: abrir cualquier archivo desde el árbol y editarlo en el lugar (`Ctrl+S` para guardar)
- **Cambios**: stage / unstage / discard por archivo, con diff lado a lado
- **Stage por hunk**: al hacer clic en un archivo cambiado se puede hacer stage, unstage o discard de cada hunk por separado, para armar commits atómicos con exactamente los cambios que se quieren (vistas workdir vs index e index vs HEAD)
- **Commit** con mensaje y autor editable (`Name <email>`)
- **Push / Pull** con autenticación por token (OAuth o PAT), repos privados incluidos
- **Pull con rebase**: reaplica los commits propios sobre el remoto para un historial lineal (selector de modo junto a Pull; ante conflictos aborta de forma segura y sugiere merge)
- **Indicadores ahead/behind**: botón Fetch + fetch automático cada 2 min; cantidad de commits entrantes y salientes como badges en Pull/Push, al estilo Sourcetree
- **Ramas**: crear, cambiar, borrar, mergear; hacer checkout de una rama remota (`origin/x`) crea la rama local correspondiente y cambia a ella; grafo de commits en SVG con varias ramas y sus etiquetas (la rama actual resaltada, las remotas punteadas)
- **Historial**: lista de commits; al hacer clic en un commit se ven los archivos que cambió y el diff por línea de cada uno, y se puede actuar sobre él: **revert seguro** (commit inverso, el historial se conserva), **cherry-pick** sobre la rama actual, **tag**, o hard reset (marcado claramente como destructivo). Las guardas de conflicto por archivo abortan limpio en lugar de adivinar
- **Amend**: casilla "Amend last commit" en el panel de commit: precarga el último mensaje, conserva el autor original y agrega lo que esté en stage
- **Tags**: crear desde cualquier commit, se muestran como chips en el grafo, push/borrado por API
- **Identidad del autor, al estilo git**: el orden de resolución es `.git/config` del repo → la cuenta del provider conectada que coincide con el origin del repo (GitHub/GitLab, con el email de commits del provider) → el default de la app (`~/.git-nd/settings.json`). Hacer un commit fija la identidad en ese repo, así cada repo puede tener su propio usuario/email (trabajo vs personal); el default global se siembra una vez y nunca se pisa
- **Stage all / unstage all** con un clic; los commits vacíos se bloquean (un commit es una foto del index: si no hay nada en stage, no hay nada que commitear)
- **Vista de merge**: todo merge con conflictos (pull, rama local o remota) abre una pestaña Merge dedicada: qué ramas se mergean, commits entrantes, cada archivo afectado (en conflicto vs mergeado automáticamente), una barra de progreso y las acciones Complete/Abort. Complete solo se habilita cuando todos los conflictos están resueltos
- **Resolución visual de conflictos**: cada conflicto es una tarjeta con LOCAL (verde) e INCOMING (azul) lado a lado y las etiquetas de rama; se resuelve por conflicto con Keep local / Take incoming / Both / Edit, con el progreso `2/3 resolved`, y Save solo se habilita cuando todo está resuelto. El contexto sin cambios se colapsa. Queda un modo texto para editar a mano, y los merges se completan con el mensaje por defecto `Merge <ref>`. Resolver un archivo vuelve a la vista Merge para elegir el siguiente
- **PRs / MRs**: lista los pull requests (GitHub) / merge requests (GitLab) abiertos con sus ramas origen → destino, y abre cada uno en el navegador. Crear un PR usa selectores de rama (sin tipear), muestra una vista previa en vivo de los commits y archivos que llevaría el PR (clic en un archivo para su diff) y avisa si la rama origen todavía no se subió
- **Stash**: guardar, aplicar, pop
- **GitHub / GitLab**: listar los repos propios (públicos y privados), clonar con un clic, crear Pull/Merge Requests, listar y crear issues
- **Refresco en vivo**: un watcher de archivos mantiene la UI sincronizada con los cambios externos; al guardar en el editor o correr git en una terminal, la lista de cambios, el chip de rama y el grafo se actualizan solos
- **Repositorios grandes**: el grafo se carga por páginas desde un único recorrido ordenado por fecha y solo dibuja las filas visibles (probado con 14k commits / 259 ramas; ver [ADR-0001](docs/adr/0001-carga-del-grafo-en-repos-grandes.md))
- **UX**: temas claro y oscuro (contraste WCAG AA, verificado por un test), íconos SVG, todo operable con teclado, un panel desplegable para Changes/Commit en ventanas angostas, toasts, eventos en tiempo real por WebSocket

## Atajos de teclado

| Atajo | Acción |
| --- | --- |
| `Ctrl/Cmd + S` | Commit, o guardar el archivo cuando la pestaña File está activa |
| `Ctrl/Cmd + Shift + P` | Push |
| `Ctrl/Cmd + P` | Ir a un archivo (quick open) |
| `Esc` | Cerrar el modal |

## Autenticación

### Opción A: Personal access token (PAT), sin configuración

1. Abrir **Connections** (el ícono del enchufe, o **Connect** en la barra superior)
2. Pegar un token; la tarjeta enlaza a la página de tokens del provider con los scopes ya seleccionados:
   - GitHub: <https://github.com/settings/tokens> (scopes `repo`, `read:user`)
   - GitLab: <https://gitlab.com/-/user_settings/personal_access_tokens> (scopes `api`, `read_user`; un GitLab self-hosted se configura con `GITLAB_URL`)

### Opción B: OAuth

Registrar una OAuth app y exportar las variables antes de arrancar:

```bash
# GitHub → Settings → Developer settings → OAuth Apps
#   Callback URL: http://localhost:3847/auth/github/callback
export GITHUB_CLIENT_ID=xxx
export GITHUB_CLIENT_SECRET=xxx

# GitLab → Preferences → Applications
#   Redirect URI: http://localhost:3847/auth/gitlab/callback  (scopes: api, read_user)
export GITLAB_CLIENT_ID=xxx
export GITLAB_CLIENT_SECRET=xxx

pnpm start
```

### Dónde se guardan los tokens

Los tokens **nunca** se guardan en el navegador. Se guardan del lado del servidor, cifrados con **AES-256-GCM**, en `~/.git-nd/tokens.enc`, así sobreviven a los reinicios del servidor. La clave de cifrado vive en `~/.git-nd/secret.key` (permisos `0600`), o se puede pasar con la variable de entorno `GITND_KEY` (32 bytes, en hex). Esto protege los tokens en reposo (backups, herramientas de sincronización); quien pueda leer los dos archivos con el usuario del sistema operativo igual puede descifrarlos: ese es el techo de cualquier app local que no usa el llavero del sistema.

## API REST

Toda petición a `/api/*` tiene que mandar el header `X-GitND: 1` (protección CSRF; la UI siempre lo manda), por ejemplo `curl -H 'X-GitND: 1' localhost:3847/api/repo/status`.

| Método | Endpoint | Descripción |
| --- | --- | --- |
| GET | `/api/fs/browse?path=` | Recorrer carpetas, repos primero (Explorer) |
| POST | `/api/repo/open` | Abrir un repo local `{ dir }` |
| GET | `/api/repo/clone-target?url=&dir=` | Dónde quedaría un clone, y si esa carpeta está vacía |
| POST | `/api/repo/clone` | Clonar `{ url, dir? }` |
| GET | `/api/repo/info` | Repo abierto: dir, nombre, rama, merge en curso |
| GET | `/api/repo/status` | Estado (staged/unstaged/untracked/conflicted) |
| GET | `/api/repo/tree?path=.` / `files` | Árbol (un nivel, carga diferida) / lista plana de archivos (quick open) |
| GET / POST | `/api/repo/file` | Leer un archivo `?path=` / escribirlo `{ path, content }` |
| POST | `/api/repo/stage` / `unstage` / `discard` | Por archivo `{ path }` |
| POST | `/api/repo/stage-all` / `unstage-all` | Stage en bloque |
| GET / POST | `/api/repo/hunks` / `hunks/:op` | Hunks de un archivo / stage, unstage o discard de algunos |
| POST | `/api/repo/commit` / `amend` | `{ message, author? }` (con un merge en curso, `commit` lo completa) |
| GET / POST | `/api/repo/author` | Autor resuelto y su origen / fijar el autor del repo |
| GET | `/api/repo/history?depth=80` | Commits con sus padres |
| GET | `/api/repo/graph?limit=&offset=&walk=&known=` / `graph/tags` | Grafo paginado (ver [flujos](docs/flows.md#6-el-grafo-de-commits-paginado)) / tags por commit |
| GET | `/api/repo/commit?oid=` | Detalle de un commit: metadatos + archivos cambiados |
| GET | `/api/repo/diff?file=&oid=` | Diff lado a lado (workdir vs HEAD, o lo que cambió un commit) |
| GET | `/api/repo/compare?base=&head=` | Commits y archivos entre dos refs (vista previa de un PR) |
| POST | `/api/repo/revert` / `cherry-pick` / `reset` | `{ oid }` |
| GET / POST | `/api/repo/tags`, `tag`, `tag/delete`, `tag/push` | Tags |
| GET / POST | `/api/repo/branches`, `branch/create` / `switch` / `delete` | Ramas |
| POST | `/api/repo/push` / `pull` | Sincronizar con `origin` (`pull` acepta `{ rebase: true }`) |
| GET / POST | `/api/repo/sync` / `sync/fetch` | Ahead/behind respecto de `origin/<rama>`, sin / con fetch previo |
| POST | `/api/repo/merge` / `merge/abort` | Mergear otra rama `{ theirRef }` / abortar |
| GET | `/api/repo/merge/state` | Merge en curso: archivos, resueltos, commits entrantes |
| POST | `/api/repo/conflict/resolve` | `{ path, content }` sin marcadores de conflicto |
| GET / POST | `/api/repo/stash` | Listar / `{ op: push\|apply\|pop\|drop }` |
| GET / POST | `/api/auth/status`, `auth/token`, `auth/logout` | Cuentas de los providers (ver [flujos](docs/flows.md#7-conectar-una-cuenta)) |
| GET | `/api/providers/list?provider=` | Repos del usuario autenticado |
| GET / POST | `/api/providers/prs` / `pr` | Listar / crear PRs o MRs |
| GET / POST | `/api/providers/issues` | Listar / crear issues |

El WebSocket en `/ws` emite: `fs-changed` (el watcher vio cambios externos), `file-changed`, `repo-opened`, `commit-completed`, `push-finished`, `pull-finished`, `branch-changed`, `merge-updated`, `stash-updated`. Qué dispara cada uno: [arquitectura → Eventos](docs/architecture.md#eventos).

## Arquitectura

```
server/
  index.js            Express + WebSocket; la guarda de localhost (Host, Origin,
                      Sec-Fetch-Site, X-GitND); mensajes de error legibles
  routes/             repo, auth (OAuth + PAT), providers
  gitService.js       Toda la lógica de Git (isomorphic-git + fs de Node, cache compartida)
  commitWalk.js       Recorrido paginado del grafo, ahead/behind por alcanzabilidad
  state.js            Repo abierto, cache, estado del merge, safePath(), broadcast del WS
  credentials.js      Qué token se puede mandar a qué URL de remoto
  tokenStore.js       Persistencia de tokens cifrada con AES-256-GCM (~/.git-nd)
  watcher.js          Cambios externos → fs-changed
  providers/          GitHub/GitLab detrás de una sola interfaz
public/               Frontend sin framework (módulos ES, sin build)
docs/                 Arquitectura, flujos (diagramas de secuencia), ADRs
```

El panorama completo (componentes, dónde vive el estado, límites de confianza y las reglas que mantienen la UI consistente) está en [docs/architecture.md](docs/architecture.md), y los flujos paso a paso en [docs/flows.md](docs/flows.md).
