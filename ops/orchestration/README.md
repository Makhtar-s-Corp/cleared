# Orchestration des agents

Le dispatcher ouvre une lane par agent, choisit son modèle dans une table, et écrit tout ce qu'il fait dans un ledger. Ticket : SEE-112. Constat de départ : [AUDIT.md](AUDIT.md). Décisions : `docs/decisions.md`, « Orchestration des agents ».

## Au quotidien

```sh
ops/orchestration/spawn-lane.sh dev SEE-105              # ouvre la lane dev/SEE-105
ops/orchestration/spawn-lane.sh dev SEE-105 --dry-run    # dit seulement quel modèle serait pris, et pourquoi
ops/orchestration/spawn-lane.sh mechanical SEE-105 --model codex-heavy  # force un modèle de la table
ops/orchestration/kill-lane.sh dev/SEE-105               # ferme la lane (terminaux, copie de travail, branche)
ops/orchestration/dashboard.sh                           # réécrit la page du tableau de bord
```

Une lane est une copie de travail git sur la branche `<rôle>/<ticket>` : Orca l'affiche sous ce nom sans rien lui demander. Son terminal lance le modèle, puis poste le compte rendu dans Linear avec le modèle réellement utilisé.

`spawn-lane.sh` refuse d'ouvrir une lane au-delà de `max_lanes` (3) et l'écrit dans le ledger. Seules les branches `<rôle>/<ticket>` comptent : les anciennes lanes ne sont ni comptées ni fermées par ces scripts.

## Changer de modèle

Tout est dans [`agents.conf`](agents.conf). Aucun script ne nomme un modèle ou un fournisseur (un test le vérifie).

- `[roles]` : le modèle par défaut de chaque rôle.
- `[rules]` : les surcharges par type de tâche, lues dans le ticket Linear (projet, étiquette) puis, quand la PR existe, dans sa taille et ses chemins. La première ligne qui correspond l'emporte.
- `[fallbacks]` : le repli de chaque modèle. Un modèle indisponible, ou un adaptateur qui refuse de démarrer, passe au repli déclaré ; c'est écrit dans le ledger et dans le commentaire Linear. Une chaîne sans modèle disponible est une erreur.
- `[review]` : une PR n'est jamais relue par le modèle qui l'a écrite.

Changer de modèle, c'est changer une ligne. Un nouveau fournisseur, c'est un fichier `adapters/<nom>.sh` et une ligne dans `[models]`.

## Le contrat d'un adaptateur

```
adapters/<nom>.sh list-models [<modèle>...]
adapters/<nom>.sh version
adapters/<nom>.sh run --model <id> --prompt-file <fichier> --report <fichier> --usage <fichier>
```

- `list-models` rend les modèles que ce fournisseur peut lancer maintenant, un par ligne. Le dispatcher l'interroge avant chaque lancement et garde un « oui » pendant un jour.
- `version` rend la version installée, la dernière publiée et le retard en jours. `check-cli.sh` l'appelle une fois par semaine : au-delà de `cli_max_days_behind` (14), il écrit un événement `cli_outdated` que le digest reprendra.
- `run` s'exécute dans la copie de travail courante et sort avec 0 (terminé), 2 (ne peut pas démarrer maintenant : rien n'est parti), 3 (son propre garde-fou refuse le contenu de la tâche) ou autre chose (échec). Après un 2, le dispatcher passe au repli déclaré. Après un 3, il s'arrête (`[policy] guard_refusal = stop`) ou passe au repli (`fallback`). Un échec du modèle n'est jamais une raison d'en essayer un autre.
- Le compte rendu a la même forme pour tous : `lib/contract.sh` l'écrit. En tête, le run, la lane, le modèle demandé, le modèle utilisé, le résultat, les tokens ; puis « Compte rendu » et « Fichiers modifiés ».
- Le fichier d'usage donne les tokens tels que la CLI les rapporte. Ce qu'elle ne donne pas reste vide.

`adapters/codex.sh` ne lance jamais Codex sur l'hôte : il appelle le script isolé du checkout principal (`scripts/codex-task.sh`), sort avec 2 tant qu'une CI tourne, et avec 3 quand le garde-fou refuse, en rendant ce refus tel quel.

## Ce qu'une lane a le droit de faire

`[permissions.<rôle>]` dans `agents.conf` : `read-only` ou `accept-edits`, la liste des seules commandes permises, et celle des commandes refusées quoi qu'il arrive. Pour `dev` : tests, vérification, build et git local ; jamais de commande réseau ni de docker, donc pas de `git push` : pousser la branche et ouvrir la PR reviendra à un script, pas au modèle. Sans écran, ce qui n'est pas dans la liste est refusé, pas demandé. C'est une consigne donnée à la CLI, pas un bac à sable : un test qu'elle a le droit de lancer reste du code. Limites connues : une commande permise garde ses options (`git diff --output=…` écrit un fichier, `git diff --no-index` lit hors de la copie de travail). La lecture directe d'un fichier hors de la copie de travail, elle, est refusée sans écran (essayé).

## Relire une PR

```sh
ops/orchestration/spawn-lane.sh review SEE-112 --pr 257
```

La lane `review/<ticket>` part de la tête de la PR, en lecture seule. `--since <commit>` limite la relecture à ce qui a changé depuis un commit déjà relu ; `--from <réf>` la fait partir d'une branche locale pas encore poussée. Le modèle vient de la table, avec la taille et les chemins de la PR ; ce n'est jamais celui qui l'a écrite (lu dans le ledger, ou donné par `--author-model`). Sans auteur connu, la relecture ne démarre pas. Son compte rendu est posté tel quel, sans passer par la mise en forme.

## Le ledger

`state/ledger.db` (SQLite), dans le checkout principal, hors de git, commun à toutes les lanes. Écrit par les scripts (`lib/ledger.mjs`), jamais par un modèle.

- `runs` : un lancement de modèle. `run_id`, `ticket`, `role`, `model`, `provider`, `started_at`, `ended_at`, `tokens_in`, `tokens_out`, `tokens_cache`, `cost_eur`, `outcome`, `pr_number`, `lines_changed`, `human_decision`, `human_latency_min`, et en plus `lane`, `source`, `requested_model`, `exit_code`, `tokens_cache_write`, `tokens_total`, `cost_basis`, `project`, `label`.
- `events` : `wake_skipped`, `monitor_expired`, `lane_limit_reached`, `prod_revert`, `model_fallback`, `model_fallback_failed`, `comment_handled` (délai, en minutes, entre un commentaire de l'utilisateur et la première action), `cli_outdated` (jours de retard d'une CLI).

`outcome` vaut `running`, `done`, `failed`, `refused`, `killed`, `idle`, puis, posés par l'étape de release : `merged`, `returned`, `reverted`.

Le coût est celui que la CLI rapporte, au tarif de l'API, converti en euros (`[currency]`). Quand elle n'en rapporte pas, il est calculé depuis `[prices]` ; sans prix, il reste vide.

```sh
node ops/orchestration/lib/ledger.mjs sql "select model, count(*), sum(cost_eur) from runs group by 1"
```

`import-legacy.mjs` relit les journaux des sessions de l'ancienne organisation (chef de projet et lanes) et les met dans le ledger avec `source = 'legacy'`, pour avoir une base de comparaison. Il peut être relancé.

## Le tableau de bord

`dashboard.sh` écrit `state/dashboard/index.html` : une page statique, une colonne, sans script. Dans l'ordre : quatre indicateurs, le coût et la qualité par modèle sur 7 jours, « En attente de toi » avec le lien vers le commentaire Linear, les abonnements et la santé du serveur.

## Deux pièges

- Ne jamais charger `.env.local` avant de lancer un modèle : il contient une clé d'API, et la facturation quitterait l'abonnement. `linear.sh` n'y lit que sa propre clé ; `adapters/claude.sh` retire la clé de l'environnement.
- Rien de réel ne part dans Linear : `linear.sh` fait passer chaque commentaire par le garde-fou du dépôt (`scripts/codex-guard.mjs`, pris dans `origin/main`) avant de l'envoyer. Un texte refusé n'est pas envoyé ; il reste dans le dossier du run.
- Les commentaires passent par la clé de l'utilisateur : Linear affiche son nom. `linear.sh` commence donc chaque commentaire par « Écrit par un agent », et garde leurs identifiants dans `state/linear-comments.jsonl`. Une veille doit s'en servir pour ne pas les prendre pour des messages de l'utilisateur.

## Servir la page

La page n'est lisible que depuis le réseau Tailscale (décision du 7 octobre) : les titres des tickets en attente y figurent, et rien de ce qui est à venir n'est public.

`serve/install.sh` installe, sans droits d'administrateur, sans conteneur et sans proxy :

- un service utilisateur, `serve/serve-dashboard.mjs`, à l'écoute sur la seule adresse Tailscale du serveur. Écouter là ne suffit pas, un conteneur de l'hôte atteint aussi cette adresse : le service refuse donc toute connexion dont la source n'est pas une machine du réseau Tailscale, et ne sert que la page ;
- une minuterie qui relance `dashboard.sh` toutes les dix minutes, en attendant que le dispatcher ait son propre réveil (phase 2). Des scripts seulement, aucun modèle.

`serve/check.sh` vérifie qui peut lire la page : cette machine par Tailscale, oui ; un conteneur, non, par aucune adresse ; rien n'écoute ailleurs. `install.sh` le lance à la fin.

Les deux services appellent les scripts du checkout d'où `install.sh` a été lancé : le relancer depuis le checkout principal une fois la PR fusionnée.
