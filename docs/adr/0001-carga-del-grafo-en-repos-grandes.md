# ADR-0001: Cargar el grafo paginado con un único recorrido y una cache de isomorphic-git por repo abierto

- Status: accepted (2026-10-29)
- Drivers:
  - En un repo de 14.061 commits, 259 ramas remotas y 1.035 tags (clon de sveltejs/svelte), abrirlo tardaba ~70 s y el proceso de Node moría por falta de memoria.
  - 259 `git.log({ depth: 100 })` sin cache: 41,8 s; con un `cache` compartido: 2,5 s. El costo era releer el packfile en cada llamada, no la cantidad de ramas.
  - "100 commits por rama" no tiene un punto de corte limpio y no se puede paginar: la unión daba 6.332 commits.
  - El README promete "no `git` binary required": el `git` nativo queda descartado mientras eso siga en pie.
- Decision:
  1. **Cache de isomorphic-git por repo abierto** (`repoState.gitCache()` en `server/state.js`), pasada a todas las lecturas. Guarda packfiles parseados (inmutables), no resultados de consultas, así que no queda desactualizada. Se libera al cambiar de repo o tras 10 min sin uso.
  2. **Grafo paginado** con un único recorrido por fecha de commit desde todas las puntas (ramas locales y remotas), con cursor append-only: las filas ya mostradas nunca se reordenan. "Cargar más" pide la página siguiente; si las refs cambiaron entre páginas, el servidor responde 409 y el cliente vuelve a cargar la misma cantidad.
  3. **Por etapas: commits + ramas juntos, tags después.** Las etiquetas de ramas salen del mismo recorrido; los tags llegan en un pedido aparte y se aplican sobre lo ya dibujado.
  4. **Comparaciones entre ramas sin ventanas fijas**: `partitionReachable` (`server/commitWalk.js`) en lugar de comparar dos `git.log` de 200/300 commits. Verificado contra `git rev-list --left-right --count` en 40 pares de ramas de svelte y en un repo con fechas empatadas.
- Tradeoff accepted:
  - El servidor pasa a guardar estado: la cache (~450 MB residentes en svelte mientras el repo está abierto) y, con el paginado, el recorrido en curso.
  - isomorphic-git carga el packfile entero en memoria, así que un repo con packs de más de ~1 GB va a seguir sin entrar.
  - Sin archivo commit-graph, el orden se basa en fechas: con clock skew un hijo puede verse debajo de su padre (1 caso en 14k commits de svelte).
- Revisit if:
  - La primera página del grafo tarda más de ~1 s en un repo como svelte, o se necesita buscar en todo el historial.
  - El producto deja de prometer "no git binary required". En ese caso, `git log --max-count` nativo con commit-graph pasa a ser la opción a evaluar.
  - Aparecen repos con packs de más de ~1 GB entre los usuarios.

## Estado de implementación

- Fase 1 (hecha): cache por repo; tags secuenciales y sin errores silenciosos (`tagsError`); `syncStatus`, `rebaseOnto`, `compareRefs` y `mergeDetail` con `partitionReachable`; `topoSort` ordenado por fecha de commit.
- Fase 2 (hecha): `GET /api/repo/graph` (cursor `walk` + `offset`, `known` para refrescos, 409 si cambiaron las refs) sobre `GraphWalk` (`server/commitWalk.js`); `GET /api/repo/graph/tags`; `GraphView` incremental en `public/js/graph.js`. Medido en svelte: primera página 0,43 s en el servidor; páginas paginadas idénticas a pedirlas de una vez; puntos y líneas del grafo paginado idénticos a dibujarlo entero; refresco sin cambios de refs no redibuja.
- Pendiente: el costo del navegador crece con las filas cargadas (cada "Cargar más" tarda 0,3 s con 200 filas y 2,6 s con 14.000; red ~0,3 s constante). Si llegar al inicio en repos grandes deja de ser raro, el paso siguiente es virtualizar (dibujar solo las filas visibles).
