# Audit de l'orchestration (phase 0)

> Document daté, gardé pour mémoire : l'état du premier serveur sur lequel l'outil a été construit, le 7 octobre 2026, avant sa première ligne. Ce n'est ni un modèle ni une description de l'outil d'aujourd'hui (voir `README.md`).

7 octobre 2026, 07 h. Lecture du serveur seulement. Un seul test pratique : un worktree créé à la main. Rien d'autre n'a été construit ni modifié.

## Confirmé

- **Orca voit un worktree git sans aucun appel à Orca.** Testé : `git worktree add -b chore/orchestration-evenementielle …`, la lane est dans `orca worktree list` cinq secondes après, nommée comme sa branche. Une branche `dev/ABC-12` donnera donc une lane `dev/ABC-12`. Orca a aussi une vraie CLI (`worktree create|rm`, `terminal create|send`, `automations`, `orchestration`), que le chef de projet utilise déjà (environ 490 commandes `orca` dans sa session, dont les créations et suppressions de lanes).
- **Session chef de projet trop longue, et pire qu'annoncé.** Ouverte le 4 octobre à 22 h 11 (pas « 11 h 57 »), 56 heures, 3 compactages, 542 000 tokens de contexte au dernier tour, 1,59 milliard de tokens relus en cache. C'est elle qui fusionne (#243 à #252 dans la nuit du 6 au 7).
- **Monitors de 30 minutes.** 35 réarmements (`timeout_ms: 1800000`), 4 expirations constatées.
- **Aucun relecteur indépendant.** Les PR #248, #250, #251, #252 ont 0 revue GitHub, toutes écrites et fusionnées par le même compte. Nuance : la lane code, le chef de projet relit et fusionne, et c'est l'outil de déploiement qui déploie seul à chaque push sur `main`.
- **Goulot côté utilisateur.** 9 tickets en In Review, 7 assignés à l'utilisateur, 2 à personne. Un de ces tickets est un compte rendu, pas un travail.
- **`claude -p` fonctionne avec le connecteur Linear.** 5 sessions sans écran le 6 octobre, 109 appels Linear. Coût mesuré : 40 000 tokens de contexte dès le premier tour, 180 000 tokens pour la plus petite, 1 million en médiane.
- **Le serveur est joignable depuis Internet** (Traefik sur 443, GitHub déclenche déjà les déploiements).

## Contesté

1. **« La règle d'accord écrit a été apprise en session » : faux.** Elle est dans `CLAUDE.md` et `docs/regles-lanes.md` depuis le 3 octobre 12 h 04, avant l'ouverture de la session. Rien à corriger.
2. **« Jusqu'à 30 minutes de latence » : à nuancer.** `watch.py` interroge déjà Linear toutes les 60 s avec `LINEAR_API_KEY`. Les 30 minutes sont le réarmement du monitor, pas le délai de réaction. Le délai réel va d'une à quelques minutes : l'événement n'arrive au chef de projet qu'à son prochain tour d'outil, et rien n'arrive entre une expiration et son réarmement. Contre-proposition : garder ce polling, le sortir de la session (service systemd), ne pas ouvrir de point d'entrée public.
3. **Un cron `claude -p` toutes les 10 minutes : trop cher et illisible.** 144 réveils par jour à 180 000 tokens au moins, soit 26 millions de tokens par jour même quand rien ne bouge, et une lane qui clignote. Contre-proposition : `orca automations create --trigger <cron> --workspace <lane> --precheck <script>`. Le script regarde Linear et GitHub sans modèle ; s'il n'y a rien, le réveil est sauté à zéro token. Une seule lane stable, historique dans `orca automations runs`. À prouver en phase 2 (aucune automatisation n'existe encore).
4. **Preview par PR : incompatible avec l'hôte.** Les previews sont désactivées, une seule app sert la prod, et une preview est une pile de 5 conteneurs. Or `docs/decisions.md` (06/10) interdit tout démarrage de conteneur pendant une CI (`ERR_NETWORK_CHANGED`), le swap est plein (7 Go sur 7) et la charge est à 14,9 pour 12 cœurs. Contre-proposition : la CI joue déjà Playwright ; le QA récupère ses captures (`scripts/ui-shots.mjs`, base permanente `cap-tests-pg`) et les poste dans Linear. Aucun conteneur en plus.
5. **Codex relecteur : interdit par l'utilisateur.** Sa consigne écrite du 5 octobre (plus aucune relecture par Codex), reprise dans `CLAUDE.md`, `regles-lanes.md` et `decisions.md`. Codex reste autorisé pour les tâches mécaniques, en conteneur (`scripts/codex-task.sh`). Contre-proposition : relecteur = session Claude neuve, prompt adversarial, jamais l'auteur.
6. **Cinq rôles : trop.** Contre-proposition : trois. Dev (la lane), relecteur (session courte), release (le chef de projet court). Le QA est un script, pas un agent.
7. **Les gates par étiquette ne tiennent pas.** Linear n'a que Feature, Improvement, Bug. `chore` n'existe pas et « CI et infra » est un projet. Contre-proposition : décider sur le projet Linear et sur les chemins touchés par la PR (`server/`, `frontend/`, `shared/`), critère déjà écrit dans `regles-lanes.md`.
8. **« Tout agent écrit dans Linear » contredit la décision du 6 octobre** (« le chef de projet est le seul à écrire dans Linear »). Il faut une décision qui la remplace.
9. **L'existant ne respecte déjà plus ses règles.** Kanban à 3 lanes, mais 15 lanes ouvertes et 13 sessions Claude vivantes sur ce dépôt. C'est la première cause de la charge de l'hôte.

Deux pièges à écrire en ADR : ne jamais charger `.env.local` avant `claude -p` (il contient `ANTHROPIC_API_KEY`, la facturation quitterait l'abonnement) ; un ticket ou un commentaire créé par un autre agent est pris par `watch.py` pour un message de l'utilisateur.

## Décisions qui reviennent à l'utilisateur

1. Chef de projet court : **A** automatisation Orca avec pré-vérification (recommandé) ou **B** cron système + `claude -p` ?
2. Détection des événements : **A** polling 60 s, rien d'exposé (recommandé) ou **B** webhooks derrière Traefik ?
3. Captures pour valider un écran : **A** captures Playwright de la CI postées dans Linear (recommandé) ou **B** preview par PR ?
4. Relecteur : lever l'interdiction Codex pour ce seul rôle ? Recommandé : **non**, session Claude séparée.
5. Trois rôles au lieu de cinq ? Recommandé : **oui**.
6. Les agents écrivent dans Linear par un script unique, ce qui remplace la règle du 6 octobre ? Recommandé : **oui**.
7. Le dispatcher applique la limite de 3 lanes en cours ? Recommandé : **oui**.
8. **GO** pour la phase 1 (`spawn-lane.sh`, `kill-lane.sh`, preuve sur ton téléphone) ?

Avant la phase 1, cette session se relance dans la lane `chore/orchestration-evenementielle` : aujourd'hui elle tourne hors d'Orca.
