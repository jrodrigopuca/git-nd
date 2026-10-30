# Cómo funciona: flujos principales

Diagramas de secuencia de lo que pasa entre el navegador, el servidor, el
repositorio en disco y los providers. Los nombres que aparecen en los
diagramas son las funciones y endpoints reales, así que cada paso se puede
buscar en el código. Las piezas en sí están descritas en
[architecture.md](architecture.md).

1. [Abrir un repositorio](#1-abrir-un-repositorio)
2. [Un cambio externo (editor, terminal)](#2-un-cambio-externo-editor-terminal)
3. [Stage y commit](#3-stage-y-commit)
4. [Push, fetch y qué token va a dónde](#4-push-fetch-y-qué-token-va-a-dónde)
5. [Pull con conflictos → resolver → completar](#5-pull-con-conflictos--resolver--completar)
6. [El grafo de commits paginado](#6-el-grafo-de-commits-paginado)
7. [Conectar una cuenta](#7-conectar-una-cuenta)
8. [Clonar](#8-clonar)

---

## 1. Abrir un repositorio

Desde Explorer (un reciente, una carpeta o "Open this repository"). Abrir un
repo afecta a todo el servidor: se avisa a todas las pestañas abiertas y
todas recargan.

```mermaid
sequenceDiagram
  autonumber
  actor U as Usuario
  participant B as Navegador (app.js)
  participant S as Servidor (routes/repo.js)
  participant G as gitService + repoState
  participant W as watcher.js
  participant D as Repositorio en disco

  U->>B: clic en un repo en Explorer
  B->>S: POST /api/repo/open { dir }
  S->>G: openRepo(dir)
  G->>D: ¿existe .git?
  G->>G: repoState.open(dir): descarta la cache y el recorrido del grafo anteriores
  G->>D: lee .git/MERGE_HEAD (loadMergeState)
  S->>W: watchRepo(dir): vigila el working tree + HEAD, refs, index, packed-refs
  S-->>B: WebSocket repo-opened (todas las pestañas)
  S-->>B: 200 repoInfo()
  B->>B: closeRepoViews(), lo agrega a recientes
  par refreshAll(): un refresco numerado, paneles en paralelo
    B->>S: GET /api/repo/info
    B->>S: GET /api/repo/status
    B->>S: GET /api/repo/branches
    B->>S: GET /api/repo/history?depth=80
    B->>S: GET /api/repo/graph?limit=200
  end
  S->>G: status(), graphPage(), …
  G->>D: lee a través de la cache compartida de isomorphic-git
  S-->>B: cinco respuestas (allSettled)
  B->>B: las descarta si empezó un refresco más nuevo, si no dibuja los paneles
  B->>S: GET /api/repo/tree (árbol de archivos)
  B->>S: GET /api/repo/graph/tags (después de la primera página)
  B->>S: GET /api/repo/sync (badges de ahead / behind)
```

- Un panel que falla se muestra vacío, nunca con el contenido del repo
  anterior.
- Otra pestaña recibe `repo-opened`, ejecuta `refreshAll()`, ve un
  `info.dir` distinto y cierra todo lo que estaba ligado al repo viejo.

## 2. Un cambio externo (editor, terminal)

Se guarda un archivo en el editor o se corre `git checkout` en una terminal.
git-nd se entera sin hacer polling.

```mermaid
sequenceDiagram
  autonumber
  actor U as Usuario (editor / terminal)
  participant D as Repositorio en disco
  participant W as watcher.js (chokidar)
  participant S as Servidor (broadcast)
  participant B as Navegador (app.js)

  U->>D: escribe archivos / mueve HEAD / actualiza el index
  D-->>W: eventos de cambio (muchos)
  W->>W: debounce de 350 ms
  W->>S: broadcast fs-changed { changes }
  S-->>B: WebSocket fs-changed
  B->>B: debounce de 250 ms (nuestras propias operaciones también lo disparan)
  B->>S: refreshAll(): info, status, branches, history, graph?known=walkId
  S-->>B: el grafo responde { unchanged } si no se movió ninguna ref (no se redibuja)
  B->>S: GET /api/repo/file (checkFileOnDisk, si hay un archivo abierto: se compara con lo cargado)
  alt editor sin cambios
    B->>B: recarga el archivo en el lugar
  else cambios sin guardar
    B->>B: los conserva, marca "changed on disk", y Save pregunta antes de pisar
  end
```

## 3. Stage y commit

```mermaid
sequenceDiagram
  autonumber
  actor U as Usuario
  participant B as Navegador
  participant S as Servidor
  participant G as gitService
  participant D as Repositorio

  U->>B: + en un archivo (o Stage all, o un hunk)
  B->>S: POST /api/repo/stage { path }
  S->>G: stage(path) → chequeo de safePath()
  G->>D: git.add (con la misma cache que todas las lecturas)
  S-->>B: ok
  B->>S: refreshAll()
  Note over B: el botón de commit dice qué va a hacer,<br/>"Commit 1 file to main", o por qué no puede
  U->>B: mensaje + Commit (o Ctrl+S)
  B->>S: POST /api/repo/commit { message, author }
  S->>G: commit()
  G->>D: loadMergeState() (si hay un merge en curso → completeMerge)
  G->>G: resolveAuthor(): .git/config del repo → cuenta del provider → default de la app
  G->>D: statusMatrix: ¿hay algo en stage?
  alt nada en stage
    G-->>B: 400 Nothing staged to commit
  else
    G->>D: git.commit
    S-->>B: WebSocket commit-completed
    S-->>B: 200 { oid }
    B->>S: refreshAll()
  end
```

## 4. Push, fetch y qué token va a dónde

La URL del remoto la define el repositorio, así que no es confiable: el token
se elige para la URL que isomorphic-git **realmente** está pidiendo, por host
exacto y solo por https.

```mermaid
sequenceDiagram
  autonumber
  actor U as Usuario
  participant B as Navegador
  participant S as Servidor
  participant T as tokenStore
  participant G as gitService
  participant C as credentials.authFor
  participant R as Remoto (github.com)

  U->>B: Push
  B->>S: POST /api/repo/push
  S->>T: tokens() (descifra ~/.git-nd/tokens.enc)
  S->>G: push({ tokens })
  G->>R: git.push (corsProxy: null)
  R-->>G: 401, la URL X pide credenciales
  G->>C: onAuth(X)
  alt X es https://github.com y hay un token de GitHub
    C-->>G: { username: token }
    G->>R: reintenta con credenciales
    R-->>G: ok
    S-->>B: WebSocket push-finished, 200
  else cualquier otro host, o http
    C-->>G: { cancel: true }
    G-->>S: UserCanceledError
    S-->>B: 500 "Authentication required. Tokens are only sent to https://github.com …"
  end
```

El fetch funciona igual (`POST /api/repo/sync/fetch`, también cada 2
minutos). Después cuenta **ahead / behind** con `partitionReachable`, que
recorre el grafo real en lugar de comparar logs de profundidad fija.

## 5. Pull con conflictos → resolver → completar

El merge en curso se guarda como lo guarda git (`.git/MERGE_HEAD`,
`.git/MERGE_MSG`) y se vuelve a leer antes de cada paso, así sobrevive a un
reinicio y coincide con lo que ve la CLI de git.

```mermaid
sequenceDiagram
  autonumber
  actor U as Usuario
  participant B as Navegador
  participant S as Servidor
  participant G as gitService
  participant D as Repositorio

  U->>B: Pull
  B->>S: POST /api/repo/pull { rebase: false }
  S->>G: pull()
  G->>D: loadMergeState(): si ya hay un merge en curso → 409
  G->>D: fetch de origin (onAuth como en el flujo 4)
  G->>G: doMerge(origin/main)
  G->>D: requireMergeableTree(): cambios sin commitear o choques con untracked → 409
  G->>D: git.merge (abortOnConflict: false)
  alt sin conflictos
    G->>D: checkout del resultado
    S-->>B: 200 merged
  else con conflictos
    G->>D: escribe MERGE_HEAD + MERGE_MSG (archivos en conflicto)
    G->>D: hace stage de los archivos mergeados automáticamente
    S-->>B: 200 { conflicts: [...] }
    B->>B: abre la pestaña Merge (progreso, archivos, commits entrantes)
  end

  loop cada archivo en conflicto
    U->>B: abre el archivo, elige Keep local / Take incoming / Both / Edit
    B->>S: POST /api/repo/conflict/resolve { path, content }
    S->>G: resolveConflict(): relee MERGE_HEAD, rechaza marcadores que quedaron
    G->>D: escribe el archivo + git.add
    S-->>B: WebSocket file-changed
    B->>S: refreshAll() → cantidad resuelta, derivada del index
  end

  U->>B: Complete merge
  B->>S: POST /api/repo/commit
  S->>G: commit() → completeMerge()
  G->>D: loadMergeState(): ¿están todos resueltos?
  G->>D: git.commit con padres [HEAD, MERGE_HEAD]
  G->>D: borra MERGE_HEAD, MERGE_MSG
  S-->>B: 200 { merged: true }
```

`Abort merge…` relee `MERGE_HEAD` primero (un merge que ya se terminó desde
una terminal no se puede "abortar" pisando trabajo más nuevo), después hace
checkout de la rama y borra los archivos del merge.

## 6. El grafo de commits paginado

Un único recorrido por fecha desde todas las puntas de rama, que se guarda en
el servidor y se extiende página por página. Las páginas solo se agregan al
final, así que las filas que ya están en pantalla nunca se mueven. Por qué
funciona así: [ADR-0001](adr/0001-carga-del-grafo-en-repos-grandes.md).

```mermaid
sequenceDiagram
  autonumber
  participant B as Navegador (GraphView)
  participant S as Servidor (graphPage)
  participant WK as repoState.graphWalk (GraphWalk)
  participant D as Repositorio

  B->>S: GET /api/repo/graph?limit=200
  S->>D: resuelve HEAD + cada rama → walkId = hash(refs)
  S->>WK: new GraphWalk(tips) si cambió el walkId
  WK->>D: lee commits del más nuevo al más viejo hasta emitir 200
  S-->>B: { walkId, commits[0..200], tips, done: false }
  B->>B: arma las lanes y dibuja solo las filas visibles de 28 px
  B->>S: GET /api/repo/graph/tags
  S-->>B: { tags } → chips en sus filas

  Note over B,S: scroll hasta el final → "Load more"
  B->>S: GET /api/repo/graph?walk=walkId&offset=200&limit=200
  alt refs sin cambios
    WK->>D: continúa el mismo recorrido
    S-->>B: commits[200..400] (se agregan al final)
  else una rama se movió mientras tanto
    S-->>B: 409 Branches changed
    B->>S: GET /api/repo/graph?limit=loaded+200 (recarga desde arriba)
  end

  Note over B,S: un refresco (watcher, commit…) sin nada nuevo
  B->>S: GET /api/repo/graph?limit=400&known=walkId
  S-->>B: { unchanged: true } (no se redibuja)
```

## 7. Conectar una cuenta

Dos caminos con el mismo resultado: un token cifrado en el servidor y la
identidad del usuario, que se muestra en Connections.

```mermaid
sequenceDiagram
  autonumber
  actor U as Usuario
  participant B as Navegador
  participant S as Servidor (routes/auth.js)
  participant P as Provider (GitHub / GitLab)
  participant T as tokenStore

  B->>S: GET /api/auth/status
  S-->>B: por provider: connected, user, oauthConfigured,<br/>ayuda del token (scopes + dónde crearlo)

  alt Personal access token
    U->>B: pega el token, Connect
    B->>S: POST /api/auth/token { provider, token }
    S->>P: getUser(token) (lo valida)
    alt válido
      S->>T: set(provider, token, user) → AES-256-GCM a disco
      S-->>B: 200 { user } → la tarjeta muestra "Connected"
    else rechazado
      S-->>B: 401 "GitHub: Bad credentials" → se muestra junto al campo
    end
  else OAuth (CLIENT_ID / CLIENT_SECRET configurados)
    U->>B: Sign in with GitHub
    B->>S: GET /auth/github/login
    S->>S: state aleatorio → sesión
    S-->>B: redirect a la URL de autorización del provider
    B->>P: authorize (los mismos scopes que la ayuda del PAT)
    P-->>B: redirect /auth/github/callback?code&state
    B->>S: GET /auth/github/callback
    S->>S: ¿el state coincide con el de la sesión?
    S->>P: exchangeCode(code) → token, getUser(token)
    S->>T: set(provider, token, user)
    S-->>B: redirect /
  end
```

## 8. Clonar

```mermaid
sequenceDiagram
  autonumber
  actor U as Usuario
  participant B as Navegador
  participant S as Servidor
  participant G as gitService
  participant R as Remoto
  participant D as Disco

  U->>B: Clone from URL… (o un repo remoto en Explorer)
  loop mientras escribe (con debounce, gana la petición más nueva)
    B->>S: GET /api/repo/clone-target?url&dir
    S->>G: cloneTargetInfo(): vacío → ~/git-nd-repos/nombre-del-repo, relativo → debajo de esa carpeta
    S-->>B: { dir, notEmpty } → "Will be cloned into …" o una advertencia
  end
  U->>B: Clone
  B->>S: POST /api/repo/clone { url, dir }
  S->>G: cloneRepo(url, dir, tokens)
  G->>D: mkdir (recuerda la primera carpeta que creó)
  G->>R: git.clone (onAuth como en el flujo 4)
  alt falla
    G->>D: borra solo lo que creó este clone
    S-->>B: error
  else ok
    G->>G: repoState.open(dir)
    S->>S: watchRepo(dir), broadcast repo-opened
    S-->>B: repoInfo → sigue como en el flujo 1
  end
```
