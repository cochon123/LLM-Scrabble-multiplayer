# Scrabble Codex

Scrabble Codex est une webapp Scrabble multijoueur temps réel, pensée pour être hébergée, avec support des parties humain vs humain, humain vs agent, agent vs agent, et chat intégré. Le serveur reste autoritaire sur toutes les règles de jeu et les agents n’écrivent jamais directement dans l’état du plateau.

Le projet a été conçu autour d’une contrainte centrale: permettre à des LLM de jouer sans casser la partie. La réponse retenue n’est pas de laisser un modèle “réécrire” librement une matrice du plateau, mais de lui fournir un contexte structuré et un ensemble d’outils serveur validés. Le modèle propose une action, le serveur la valide, puis l’applique ou la refuse avec un diagnostic détaillé.

## Fonctionnalités

- salons de partie configurables avec 2 à 4 sièges
- sièges humains ou agents IA par siège
- fournisseurs IA supportés:
  - `openai_compatible`
  - `openrouter`
  - `google`
  - `ollama`
- chat temps réel entre humains et agents
- placements de mots, échanges de tuiles, passe, score, fin de partie
- option de partie pour activer l’affichage des coups légaux côté humains
- option par agent pour autoriser ou non l’outil `list_legal_moves`
- drag-and-drop des lettres sur le plateau pour les humains
- trace agent détaillée dans l’UI:
  - prompt
  - contextes envoyés
  - reasoning si exposé par le fournisseur
  - réponses modèle
  - tool calls
  - résultats d’outils
- logs persistants JSONL par salon pour rejouer le déroulement d’une partie

## Stack

- frontend: React 19 + Vite
- backend: Node.js + Express + Socket.IO
- moteur de jeu: TypeScript partagé côté serveur/client
- styles: Tailwind via CDN dans `index.html`
- tests: Vitest

## Démarrage

Installation:

```bash
npm install
```

Développement:

```bash
npm run dev
```

URLs par défaut:

- frontend: `http://localhost:5173`
- backend: `http://localhost:3001`

Production:

```bash
npm run build
npm start
```

## Variables et configuration

### Serveur

- `PORT`: port HTTP du serveur, par défaut `3001`
- `DICTIONARY_PATH`: path to the dictionary to load, default `public/dictionary/en-large.txt`

### Fournisseurs IA

Les clés peuvent être passées soit dans l’UI du siège agent, soit via variables d’environnement.

- OpenAI-compatible:
  - `OPENAI_API_KEY`
  - `OPENAI_COMPAT_BASE_URL`
- OpenRouter:
  - `OPENROUTER_API_KEY`
- Google AI:
  - `GOOGLE_API_KEY`
- Ollama:
  - pas de clé par défaut, endpoint local `http://127.0.0.1:11434/api/chat`

### Presets d’URL dans l’UI

Quand on change de fournisseur dans le lobby, l’UI préremplit maintenant l’URL adaptée:

- `openai_compatible` -> `http://127.0.0.1:1234/v1/chat/completions`
- `openrouter` -> `https://openrouter.ai/api/v1/chat/completions`
- `google` -> vide, le backend construit l’URL native Google
- `ollama` -> `http://127.0.0.1:11434/api/chat`

## Dictionnaire

The server now loads `public/dictionary/en-large.txt` by default. Word loading normalizes entries as:

- suppression des diacritiques
- suppression des caractères non alphabétiques
- passage en majuscules

Le moteur travaille donc sur des formes normalisées.

## Philosophie agentique

Le point critique du projet est le suivant: un LLM ne doit pas avoir l’autorité sur l’état du jeu.

Le système n’utilise donc pas une matrice “à renvoyer modifiée” comme source de vérité. Le modèle reçoit un contexte, mais agit uniquement via des outils:

- `get_state {}`
- `list_legal_moves {"limit": number}`
- `play_move {"placements":[{"row":number,"col":number,"letter":"A"}]}`
- `exchange_tiles {"letters":["A","E"]}`
- `send_chat {"message":"..."}`
- `pass_turn {}`

Le serveur:

1. reçoit un appel d’outil
2. valide les arguments
3. vérifie les règles métier
4. applique ou refuse l’action
5. renvoie un diagnostic détaillé

Conséquences:

- un agent peut se tromper sans corrompre la partie
- les erreurs sont observables et exploitables pour itérer
- on peut autoriser ou non `list_legal_moves` selon le niveau d’assistance voulu

## Convention de coordonnées

Les outils agent utilisent des coordonnées `0-indexées`.

Exemples:

- coin haut gauche: `row 0, col 0`
- centre du plateau 15x15: `row 7, col 7`

Les messages d’erreur détaillés rappellent cette convention et affichent aussi la coordonnée “humaine” équivalente pour éviter toute ambiguïté.

## Architecture

### Vue d’ensemble

Le projet est organisé en trois zones:

```text
src/
  client/
    App.tsx
    main.tsx
  server/
    ai.ts
    index.ts
    logger.ts
    room-manager.ts
  shared/
    agent-prompt.ts
    constants.ts
    dictionary.ts
    game.ts
    game.test.ts
    types.ts
public/
  dictionary/
    fr-basic.txt
    fr-large.txt
```

### `src/client`

#### [`App.tsx`](/home/cochon/Documents/miniproject/scrabble_codex/src/client/App.tsx)

Contient l’essentiel de l’application frontend:

- connexion Socket.IO
- création et join de salon
- édition des sièges du lobby
- rendu du plateau, chevalet, chat, scores, journal
- affichage optionnel des coups légaux
- rendu des traces agents
- interactions humaines:
  - clic
  - drag-and-drop
  - échange de tuiles
  - chat

Le client reste volontairement léger: il prépare l’intention utilisateur, mais toutes les règles sont validées côté serveur.

#### [`main.tsx`](/home/cochon/Documents/miniproject/scrabble_codex/src/client/main.tsx)

Bootstrap React minimal.

### `src/server`

#### [`index.ts`](/home/cochon/Documents/miniproject/scrabble_codex/src/server/index.ts)

Point d’entrée serveur:

- création du serveur HTTP
- montage de Socket.IO
- chargement du dictionnaire
- construction du `RoomManager`
- service des assets frontend en production

#### [`room-manager.ts`](/home/cochon/Documents/miniproject/scrabble_codex/src/server/room-manager.ts)

Orchestrateur principal des salons et des parties:

- attache les sockets
- crée les salons
- gère les joins/reconnects
- met à jour les sièges et options
- démarre les parties
- relaie les actions humaines au moteur
- déclenche les tours agents
- construit la `RoomView` envoyée au frontend

Le `RoomManager` est aussi l’endroit où sont:

- stockés les traces agents
- stockées les conversations cumulées par agent
- écrits les logs persistants JSONL

#### [`ai.ts`](/home/cochon/Documents/miniproject/scrabble_codex/src/server/ai.ts)

Couche d’orchestration agent:

- construit le prompt système effectif
- accumule la conversation du modèle au fil des tours
- construit le transcript de contexte
- appelle le fournisseur choisi
- parse le JSON renvoyé par le modèle
- exécute les outils autorisés
- enregistre la trace détaillée
- déclenche un moteur de secours si aucune action valide n’est obtenue

Le moteur de secours n’est pas exposé comme fournisseur dans l’UI. Il sert uniquement de filet de sécurité serveur.

#### [`logger.ts`](/home/cochon/Documents/miniproject/scrabble_codex/src/server/logger.ts)

Journalisation durable par salon dans `runtime-logs/rooms/<roomId>.jsonl`.

Chaque ligne contient:

- timestamp
- roomId
- type d’événement
- payload sérialisé

Usage principal:

- débugguer les agents
- rejouer le déroulé d’une partie
- comprendre pourquoi un `tool_call` a échoué

### `src/shared`

#### [`types.ts`](/home/cochon/Documents/miniproject/scrabble_codex/src/shared/types.ts)

Contrats partagés:

- types du jeu
- payloads socket
- configuration agent
- traces agents
- snapshots de partie

#### [`constants.ts`](/home/cochon/Documents/miniproject/scrabble_codex/src/shared/constants.ts)

Constantes de plateau et de distribution des lettres.

#### [`dictionary.ts`](/home/cochon/Documents/miniproject/scrabble_codex/src/shared/dictionary.ts)

Chargement et normalisation du dictionnaire.

#### [`game.ts`](/home/cochon/Documents/miniproject/scrabble_codex/src/shared/game.ts)

Moteur Scrabble autoritaire. C’est la pièce la plus importante côté métier.

Responsabilités:

- état du plateau
- état des joueurs
- sac de lettres
- validation des coups
- calcul du score
- génération de coups légaux
- échanges et passes
- détection de fin de partie

Le moteur renvoie des diagnostics explicites quand un coup échoue, par exemple:

- coup flottant
- mot principal avec trou
- case déjà occupée
- mot invalide avec coordonnées
- coup hors centre au premier tour
- tuile absente du chevalet

#### [`agent-prompt.ts`](/home/cochon/Documents/miniproject/scrabble_codex/src/shared/agent-prompt.ts)

Prompt système par défaut pour les agents. Il insiste notamment sur:

- réponse en JSON unique
- outillage disponible
- nécessité de finir le tour par une action terminale
- jeu en français
- coordonnées `0-indexées`
- possibilité d’utiliser le chat si pertinent

#### [`game.test.ts`](/home/cochon/Documents/miniproject/scrabble_codex/src/shared/game.test.ts)

Couverture minimale du moteur:

- validation du premier coup
- calcul de score
- génération de coups légaux
- diagnostics d’erreurs structurés

## Cycle d’un tour agent

1. `RoomManager` détecte que le joueur courant est un agent.
2. `ai.ts` ouvre ou reprend la conversation cumulée de cet agent.
3. Le backend construit un contexte:
   - chevalet de l’agent
   - scores
   - plateau
   - dernier coup
   - chat récent
   - historique d’outils
4. Le fournisseur renvoie un objet JSON `{tool, arguments}`.
5. Le serveur exécute l’outil.
6. Le résultat est renvoyé au modèle et ajouté à la trace.
7. Si aucune action valide n’aboutit après plusieurs étapes, le moteur de secours joue à la place.

## Traces et logs

Deux niveaux d’observabilité existent:

### Trace UI

Visible pendant la partie dans le panneau `Trace agents`:

- prompt
- contextes successifs
- reasoning
- réponses modèle
- tool calls
- résultats

### Log disque

Écrit dans `runtime-logs/rooms/`.

Exemples d’événements:

- `room_created`
- `seat_updated`
- `game_started`
- `human_move_rejected`
- `human_move_applied`
- `agent_turn_started`
- `agent_trace_started`
- `agent_trace_event`
- `agent_turn_completed`
- `agent_move_applied`
- `game_finished`

Ce log est la meilleure source pour analyser un agent après coup.

## UI et styling

Le projet utilise Tailwind via CDN dans [index.html](/home/cochon/Documents/miniproject/scrabble_codex/index.html), sans fichier CSS séparé. C’est pratique pour itérer vite, mais pour une mise en production plus stricte, une compilation Tailwind via Vite serait plus propre.

## État actuel et limites

Le projet est fonctionnel, mais il faut garder en tête:

- pas d’authentification
- pas de persistance base de données
- pas de reprise de partie après redémarrage serveur
- dictionnaire large mais pas présenté comme lexique officiel de compétition
- le moteur de secours peut masquer certaines limites de raisonnement des modèles
- la trace UI est pensée pour le débogage, pas pour un public final

## Déploiement

Le mode production sert:

- les assets frontend depuis `dist/`
- le backend Node depuis `dist-server/server/index.js`

Séquence standard:

```bash
npm run build
npm start
```

## Commandes utiles

```bash
npm run dev
npm run build
npm start
npm test
```

## Résumé de conception

L’idée clé du projet est simple:

- les humains jouent via une UI web
- les agents jouent via des outils
- le serveur garde toute l’autorité métier

Ce choix rend possible un Scrabble réellement multijoueur avec LLM sans laisser les modèles casser l’état du jeu.
