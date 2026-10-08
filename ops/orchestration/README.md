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

`spawn-lane.sh` refuse d'ouvrir une lane au-delà de `max_lanes` (3) et l'écrit dans le ledger. Seuls les rôles de `counted_roles` (`dev`, `mechanical`) prennent une de ces places. Orca ne connaît une copie de travail que quelques secondes après git, parfois bien plus : le script réessaie pendant 120 secondes, puis une dernière fois ; une attente de plus de 30 secondes et un échec sont écrits au ledger (`orca_terminal_delayed`, `orca_terminal_failed`). Seules les branches `<rôle>/<ticket>` comptent : les anciennes lanes ne sont ni comptées ni fermées par ces scripts.

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
adapters/<nom>.sh talk --model <id> --prompt-file <fichier> [--session-id <uuid>]
```

- `list-models` rend les modèles que ce fournisseur peut lancer maintenant, un par ligne. Le dispatcher l'interroge avant chaque lancement et garde un « oui » pendant un jour.
- `version` rend la version installée, la dernière publiée et le retard en jours. `check-cli.sh` l'appelle une fois par semaine : au-delà de `cli_max_days_behind` (14), il écrit un événement `cli_outdated` que le digest reprendra.
- `run` s'exécute dans la copie de travail courante et sort avec 0 (terminé), 2 (ne peut pas démarrer maintenant : rien n'est parti), 3 (son propre garde-fou refuse le contenu de la tâche) ou autre chose (échec). Après un 2, le dispatcher passe au repli déclaré. Après un 3, il s'arrête (`[policy] guard_refusal = stop`) ou passe au repli (`fallback`). Un échec du modèle n'est jamais une raison d'en essayer un autre.
- Le compte rendu a la même forme pour tous : `lib/contract.sh` l'écrit. En tête, le run, la lane, le modèle demandé, le modèle utilisé, le résultat, les tokens ; puis « Compte rendu » et « Fichiers modifiés ».
- Le fichier d'usage donne les tokens tels que la CLI les rapporte. Ce qu'elle ne donne pas reste vide.
- Le modèle inscrit pour une session est celui qui a écrit ses messages. Un modèle d'appoint que la CLI consulte d'elle-même (le « conseiller » de Claude Code) est compté dans les tokens et le coût de la session ; ce qu'il a coûté à lui seul n'est que dans le fichier d'usage de la session (`state/runs/<session>/<rôle>-usage-*.json`, champ `helpers`), pas au ledger ; `advisor = no` dans les permissions d'un rôle lance ce rôle sans lui.
- `talk` tient une conversation avec l'utilisateur dans le terminal courant, ouverte par le prompt, et sort avec 2 si ce fournisseur n'en propose pas ici. Rien n'y est demandé à l'écran : ce que les permissions ne nomment pas est refusé ; `ORCH_EDIT_ONLY` nomme le seul fichier modifiable.

`adapters/codex.sh` ne lance jamais Codex sur l'hôte : il appelle le script isolé du checkout principal (`scripts/codex-task.sh`), sort avec 2 tant qu'une CI tourne, et avec 3 quand le garde-fou refuse, en rendant ce refus tel quel.

## Ce qu'une lane a le droit de faire

`[permissions.<rôle>]` dans `agents.conf` : `read-only` ou `accept-edits`, la liste des seules commandes permises, et celle des commandes refusées quoi qu'il arrive. Pour `dev` : tests, vérification, build et git local ; jamais de commande réseau ni de docker, donc pas de `git push` : pousser la branche et ouvrir la PR reviendra à un script, pas au modèle. Sans écran, ce qui n'est pas dans la liste est refusé, pas demandé. C'est une consigne donnée à la CLI, pas un bac à sable : un test qu'elle a le droit de lancer reste du code. Limites connues : une commande permise garde ses options (`git diff --output=…` écrit un fichier, `git diff --no-index` lit hors de la copie de travail). La lecture directe d'un fichier hors de la copie de travail, elle, est refusée sans écran (essayé).

## Relire une PR

```sh
ops/orchestration/spawn-lane.sh review SEE-112 --pr 257
```

La lane `review/<ticket>` part de la tête de la PR, en lecture seule. `--since <commit>` limite la relecture à ce qui a changé depuis un commit déjà relu ; `--from <réf>` la fait partir d'une branche locale pas encore poussée. Le modèle vient de la table, avec la taille et les chemins de la PR ; ce n'est jamais celui qui l'a écrite (lu dans le ledger, ou donné par `--author-model`). Sans auteur connu, la relecture ne démarre pas. Son compte rendu est posté tel quel, sans passer par la mise en forme.

## Le chef de projet en sessions courtes

`wake.sh` tourne toutes les minutes (minuterie du serveur). Il lit Linear et GitHub par des scripts et compare avec ce que le réveil d'avant a vu :

- rien n'a bougé : il écrit « réveil sauté » au ledger et s'arrête. Zéro token ;
- quelque chose a bougé (un commentaire ou un ticket de l'utilisateur, une PR ouverte, passée en « prête », fusionnée ou fermée, ses vérifications qui passent au vert ou au rouge) : il lance une seule session courte du rôle `[lead] role`, dans sa lane stable `release/lead`, avec le modèle de la table, et lui remet la liste. Ce qu'un agent a écrit n'est jamais un événement.

Tout ce qui bouge ne vaut pas une session. `[lead] wake_on` nomme ce qui en lance une à lui seul (un commentaire de l'utilisateur, le message d'une lane, des vérifications qui passent au vert ou au rouge, une fusion). Le reste (une PR ouverte en brouillon, passée en « prête » alors que ses vérifications tournent encore, fermée, un ticket créé) attend dans l'état du réveil et est remis à la session suivante, avec ce qui la lance : rien n'est perdu, et aucun modèle ne démarre pour constater qu'il n'a rien à décider. Mesure du 7 octobre, sur quinze sessions : neuf sans rien à décider, dont six lancées par l'un de ces quatre événements. Le ledger dit pourquoi chaque session a été lancée (`wake_started`, avec la liste de ce qui a bougé)  ; pour recompter les sessions lancées à partir de cette version : `select detail from events where kind = 'wake_started'` (celles d'avant se lisent dans `state/runs/lead-*/events.json`).

GitHub en panne : le réveil lit la page d'état publique de GitHub chaque minute. Une panne (pas un ralentissement) de git, des pull requests, d'Actions ou de l'API est notée à son début et écrite au ledger à sa fin, en une ligne `github_down` (heure de début, durée en minutes, ce qui était en panne) ; le tableau de bord l'affiche dans « Santé du serveur », pour expliquer les trous. Pendant la panne, les PR ne sont pas lues : ce qu'elles semblent faire (des vérifications que GitHub annule lui-même) ne réveille personne et n'est pas oublié, c'est relu au retour. Un commentaire de l'utilisateur ou le message d'une lane lancent toujours une session, à qui il est dit que rien ne peut partir. `host-state.sh` dit alors que la machine n'est libre pour rien.

Le chef de projet ne tourne que sur le modèle décidé en dernier pour son rôle. Chaque changement s'écrit au ledger (`ledger event --kind role_model_changed --detail "<rôle>: <avant> -> <après>: <raison>"`) ; `check-lead-model.sh` compare la table à cette dernière décision, et refuse si elles diffèrent. La minuterie des réveils le lance à chaque démarrage, à la main aussi (`orchestration-lead-model.service`) : elle ne démarre pas sur un modèle écarté, et chaque réveil le revérifie. Si le modèle du rôle n'est pas disponible, le chef de projet attend : aucun autre modèle ne prend sa place (c'est écrit au ledger, et ce qui a bougé est remis au réveil suivant). Ce qu'il poste dit quel modèle l'a écrit : « Écrit par un agent (chef de projet, modèle …) ».

Le pré-contrôle n'ouvre jamais de terminal : il tourne dans la minuterie du serveur. Orca ne montre un terminal que lorsqu'une session démarre, un par session, dans la lane `release/lead`. À la fin de chaque session, `lane-run.sh` ferme les terminaux des sessions plus anciennes et n'en garde que `[lead] terminals_kept` ; ce qu'une session a dit reste dans `state/runs/` et dans le ledger.

Une session encore au travail retient la suivante, sans rien perdre de ce qui bouge entre-temps. Si une session s'arrête sans le dire (terminal tué), le réveil suivant attend au plus `[lead] max_minutes`. La lane du chef de projet n'est jamais remise à zéro : s'il y reste un fichier suivi modifié ou un commit à elle, le réveil s'arrête, n'y touche pas, et l'écrit une fois au ledger (`lead_lane_blocked`). Un fichier non suivi laissé là ne bloque rien. Une source qui ne répond pas : le réveil ne lit rien et n'avance pas.

`[lead] live = no` : le chef de projet observe. Il écrit ce qu'il ferait, dans son compte rendu (`state/reports/`), et ne fait rien : ni commentaire, ni lane, ni fusion. Seule exception, le réveil de passation décrit plus bas, qui poste un commentaire dans un ticket. Tant que l'ancien chef de projet tourne, c'est le seul mode ; `wake.sh` refuse `live = yes`, qui n'est pas construit.

Ce que reçoit le modèle : la liste de ce qui a bougé contient des titres et des commentaires de Linear, tels quels. Elle ne passe pas par le garde-fou quand le rôle est servi par Claude, qui lit déjà le dépôt et Linear pour tout le reste ; l'adaptateur de Codex, lui, fait passer par le garde-fou tout ce qu'il envoie. « Aucune donnée réelle dans Linear » reste la règle qui protège ce chemin.

`[lead] live = yes` : le chef de projet agit, dans les limites de `[permissions.<rôle>-live]`. Première étape, la seule construite : il répond.

- Il est réveillé aussi par le dernier message d'une lane déjà au travail, quand ce message s'adresse au chef de projet (`lib/lanes.mjs` le lit dans le journal de session de la lane ; une lane ne lit pas Linear).
- Il répond à Makhtar dans Linear avec `linear.sh comment <ticket> -`, qui fait passer tout texte par le garde-fou et le signe « chef de projet ». Tous les agents ensemble ne lui écrivent pas plus de `[linear] comments_per_hour` commentaires par heure : au-delà, `linear.sh` refuse et le message est à grouper, plus tard. Le compte rendu de fin d'une lane ainsi retenu n'est pas perdu : il est gardé dans `state/linear-outbox/` et part au premier réveil où l'on peut de nouveau lui écrire, avec les autres, en un seul commentaire groupé dans le ticket de suivi. Ce que l'utilisateur confirme lui-même (`confirm-decision.sh`) n'est jamais retenu : c'est sa parole, pas un message d'agent de plus.
- Il lit ce que Makhtar a écrit dans Linear (`linear.sh comments`, `issue`, `waiting`) : il n'a pas de mémoire, les accords sont là.
- Il répond à une lane dans son terminal avec `tell-lane.sh <lane> -`. Le terminal de chaque lane est écrit dans `state/lanes.json` par `adopt-lane.sh <lane> <terminal>`, que lance celui qui confie les lanes au chef de projet, jamais le chef de projet lui-même. Rien ne part vers un terminal inconnu, parti, ou d'une autre copie de travail : le chemin qu'Orca donne pour le terminal doit être, en entier, celui que git donne pour la copie de travail de ce nom. Si Orca ne répond pas, le script le dit et s'arrête. Une lane ne reçoit pas plus de `[lead] messages_per_lane_per_hour` messages par heure. Chaque message est gardé dans `state/lane-messages.jsonl`.
- Une lane ne se voit jamais dire de fusionner ni de forcer un envoi. `lib/lane-message.mjs` lit le message proposition par proposition et refuse celle qui nomme une fusion ou un envoi forcé (« fusionne », « tu peux fusionner », « merge », « force push », `--force`, `push -f`), sauf si elle dit de ne pas le faire (« ne fusionne pas », la négation au plus trois mots avant), ce que le chef de projet ou un script fera lui-même (« je fusionnerai ») ou ce qui est fait (« #12 est fusionnée »). C'est un filet, pas le contrôle : il se trompe dans les deux sens (une tournure inattendue passe, une phrase innocente est refusée et son auteur la reformule). Le contrôle, c'est la liste de ce que le chef de projet a le droit de lancer et l'accord écrit de Makhtar.
- `host-state.sh` lui dit si la machine est libre : CI en cours, déploiement possible, test d'écran ou capture en cours, état de chaque PR ouverte. Deux de ces réponses sont des approximations. « Déploiement possible » : moins de dix minutes depuis le dernier changement de `main`, ou des conteneurs démarrés depuis moins de quatre minutes ; rien n'interroge Coolify. « Test d'écran en cours » : `lib/screens.mjs` lit la table des processus et compte les commandes qui en lancent un (`npm run test:ui`, `scripts/run-ui-tests.mjs`, `scripts/capture-*.mjs`, `scripts/ui-shots.mjs`, `playwright test`) et leur navigateur sans écran ; une commande qui en nomme seulement un (un prompt, une recherche) ne compte pas. Un test d'écran lancé autrement n'est pas vu.
- Le dernier message d'une lane ne compte que s'il a plus de 45 secondes (son tour est fini) et moins de `[lead] report_hours` heures.
- **Contrôles de nuit.** Les vérifications que la forge lance d'elle-même sur la branche principale (`[lead] night_checks_event`) sont lues à chaque réveil. Vertes : aucun événement, rien de gardé, rien d'écrit. Rouges (`night_check_failed`, dans `wake_on`) : le chef de projet est réveillé, ouvre un ticket en langage produit (`linear.sh create`, projet et étiquette de `[lead] night_ticket`) et garde une ligne pour le digest du matin (`digest-note.sh -`, qui écrit dans `state/digest-notes.jsonl` après le garde-fou). Une série arrêtée par quelqu'un n'est ni l'un ni l'autre.
- **Ménage des lanes.** Une fois par jour, au premier réveil après `[lanes] tidy_hour`, `tidy-lanes.sh` ferme par règle, sans modèle : une lane dont la PR est fusionnée ou fermée ; une lane sans activité depuis `[lanes] idle_hours` à laquelle aucun ticket ouvert ne se rattache ; une lane d'essai (`[lanes] trial_prefixes`). Jamais une lane rattachée à un ticket en cours, en demande d'accord ou en accord (les tickets d'une lane sont ceux que nomment sa branche et ses PR ; un ticket dont l'état ne se lit pas compte comme en cours). Rien n'est perdu : ce qui n'existe que dans la copie de travail est archivé sous `[lanes] archives`, le travail non enregistré devient un commit « wip », ce que le dépôt distant n'a pas est poussé sur la branche de la lane (jamais forcé, jamais la base, et seulement si le garde-fou le laisse sortir : sinon la lane reste telle quelle). La branche reste sur le dépôt distant ; seuls les terminaux et la copie de travail disparaissent. `tidy-lanes.sh --dry-run` dit ce qu'il ferait. Ce qui a été fermé est écrit au ledger (`lanes_tidied`) et noté pour le digest, avec le nombre de lanes restantes et de sessions de modèles encore vivantes.

Deuxième étape : il fait relire une PR. `review-pr.sh <numéro> <ticket>` ouvre une lane de relecture (`review/<ticket>`) avec un modèle autre que celui qui a écrit la PR, et ne décide rien par jugement : le ticket lui est donné (une PR peut n'en nommer aucun, ou plusieurs : essayé, deviner se trompe) ; un commit déjà relu n'est pas relu, et si un commit plus ancien l'a été, seul ce qui a changé depuis est lu ; l'auteur est le modèle de la session de la copie de travail de cette branche (sans auteur connu, pas de relecture) ; une relecture à la fois par ticket, la précédente, terminée, étant fermée au passage ; pas plus de `[review] per_hour` par heure. Une lane de relecture ne fait que lire (ni installation ni test) : elle n'est pas une opération lourde de la machine et peut s'ouvrir pendant une CI ; Une relecture qui ne peut pas s'ouvrir tout de suite (limite de l'heure, relecture du même ticket encore en cours, panne que GitHub annonce lui-même) n'est pas refusée puis oubliée : elle attend dans `state/reviews-queue/`, et le réveil l'ouvre de lui-même dès que possible, sans modèle, une par minute au plus. Celle qui ne pourra jamais s'ouvrir (PR fermée, version déjà relue) est retirée de la file. Rien n'est posté dans Linear : ce que dit le relecteur est remis au chef de projet à son réveil suivant (événement `review_done`), qui transmet les défauts à la lane.

Troisième étape : il met en ligne, par un script qui vérifie et ne juge rien.

- **Demander l'accord.** `ask-validation.sh <ticket> - --pr <PR>... [--capture <image> "<légende>"]...` poste la demande sur le ticket, en langage produit, avec les captures quand c'est un écran, et passe le ticket dans `[linear] validate_state` (« À valider »). La demande porte sur des PR, à la version où chacune se trouve : la dernière ligne du commentaire le dit, et `state/validations/<ticket>.json` le garde. Une seule fois par version. Une capture ne part que si c'est une image (ses premiers octets le disent, pas son nom) rangée dans le dossier qu'une lane réserve à ce qui peut sortir (`[linear] capture_roots` : `.local/captures-linear/` de sa copie de travail, directement dedans) ; le reste d'une copie de travail ne part jamais, et si une capture ne peut pas partir, rien n'est demandé. Le garde-fou lit le texte d'un commentaire, pas une image : ce dossier ne reçoit que des captures prises sur les données de démonstration.
- **L'accord.** L'utilisateur passe lui-même le ticket dans `[linear] go_state` (« Go MEP »). Aucun script ne pose ce statut : `linear.sh move` ne va que vers « À valider » et « Done ». `linear.sh moved-by-owner` lit l'historique : le dernier passage dans ce statut doit venir du compte de l'utilisateur, pas d'une intégration ni d'un autre compte. Limite connue, écrite dans `docs/decisions.md` : Linear ne distingue pas l'utilisateur d'un programme qui agit sous son compte.
- **Mettre en ligne.** `merge-pr.sh <PR> <ticket> [<annonce|->]` vérifie tout, à chaque fois, et dans cet ordre : PR ouverte, pas en brouillon, toutes ses vérifications vertes ; branche à jour de la base, ou en retard seulement sur ce qui n'est pas du code (`[merge] code_paths`) ; version relue par un autre modèle que son auteur, pour ce ticket, avec le verdict `[merge] verdict` (le commit relu est la tête, ou la tête n'ajoute que des fusions de la base qui n'ont rien changé d'elles-mêmes) ; accord de l'utilisateur ; machine libre pour une fusion. Une seule mise en ligne à la fois, de la première lecture à la fusion (un verrou, `state/merge.lock`). Puis il fusionne le commit même qu'il a vérifié, poste l'annonce sur le ticket et, quand tout ce qui lui a été montré sur ce ticket est en ligne, le passe en « Done ». Codes de sortie : 0 en ligne, 3 mise en file, 6 refus.
  - Ce qu'une PR change est lu dans git (`git diff --name-only --no-renames`), pas dans la liste de GitHub, qui s'arrête à cent fichiers ; pour un fichier déplacé, l'endroit d'où il vient compte autant que celui où il va.
  - Ce qui part sans accord, une fois relu et vert (`[merge] tooling_paths`) : ce que seuls des gens lisent, c'est-à-dire les deux manuels de ce dossier, nommés exactement (un fichier est ce fichier, seul un nom finissant par « / » est un dossier). Ce qui touche `[merge] guarded_paths` demande toujours l'accord de l'utilisateur : les vérifications automatiques, le déploiement, ses règles écrites (`CLAUDE.md`, `docs/regles-lanes.md`), le registre des décisions (les consignes du relecteur, du chef de projet et de la discussion le donnent aux agents comme leurs règles), et tout l'outillage de l'orchestration (ce dossier, ses réglages, ses tests). La raison : la mise en ligne dépend de presque tous ces fichiers (ce qui dit « relu », « vert », « machine libre », jusqu'à ce qui lance un relecteur et écrit son compte rendu), et une PR d'outillage partie seule pourrait donc l'ouvrir. De deux chemins qui contiennent un fichier, le plus long dit ce qu'il est.
  - L'accord vaut pour la version montrée. Un ticket en « Go MEP » pour une PR qu'on ne lui a jamais montrée n'est pas mis en ligne ; si la lane a poussé un changement à elle depuis la demande, le ticket revient en « À valider » (`merge_refused`) et la demande est refaite avec la nouvelle version. Des fusions de la base qui n'ont rien changé d'elles-mêmes ne comptent pas comme un changement. Une deuxième PR du même ticket s'ajoute à ce qui lui a été montré ; une PR montrée puis fermée sans être mise en ligne ne retient pas le ticket. Si GitHub ne sait pas dire ce qu'elle est devenue au moment de la mise en ligne, le ticket n'est pas fermé au jugé : c'est écrit au ledger (`ticket_left_open`), dit au chef de projet, et le réveil redemande de lui-même, sous le même verrou que les mises en ligne. Rien n'est abandonné en silence : tant que cette PR est ouverte ou inconnue, ou que Linear ne répond pas, le réveil réessaie ; il ferme le ticket s'il est toujours là où l'utilisateur l'a mis, et sinon le laisse tel quel en le disant.
  - Une ligne « Fusion : <ticket> » de l'utilisateur vaut encore accord si elle vient de son compte, a été écrite (et réécrite pour la dernière fois) avant `[merge] lines_until`, le moment où ses deux statuts ont été créés, et après l'ouverture de la PR : il a donné son accord à ce qui existait. Linear ne distinguant pas l'utilisateur d'un programme qui agit sous son compte, aucune ligne écrite depuis ne compte. Pour une PR gardée, la ligne nomme la PR (« Fusion : <ticket> #<PR> »).
  - Un ticket trouvé dans « Go MEP » sans que l'utilisateur l'y ait mis n'est jamais mis en ligne : il revient en « À valider », et c'est écrit au ledger (`merge_refused`).
  - « Pas maintenant » (une vérification tourne encore, la machine est prise) n'est pas un refus : la mise en ligne attend dans `state/merge-queue/` et le réveil la refait de lui-même, sans modèle, avec tous les contrôles, une par minute au plus. Elle n'attend pas sans fin : après `[merge] queue_hours` heures, elle quitte la file. Un refus dit ce qui doit changer ; une mise en ligne qui quitte la file sans être faite est dite au chef de projet.
- Le chef de projet est réveillé quand un ticket entre dans « Go MEP » (`ticket_moved`). Le ledger garde chaque mise en ligne faite par le script (`merged_by_script`, avec ce qui a été vérifié).

Il n'ouvre aucune autre lane, n'en ferme aucune et ne pousse rien : ces scripts lui sont refusés. Il ne change le statut d'un ticket que par ces scripts. À une lane, il ne transmet que ce qui découle d'un accord écrit de Makhtar, la coordination de la machine, et les défauts qu'un relecteur a trouvés dans sa PR ; le reste, il le lui demande.

Prendre la suite d'un autre chef de projet : `wake.sh --handover <fichier>` lance une seule session, qu'il y ait du nouveau ou non. Elle relit la passation du fichier et dit, dans le ticket de `[lead] report_on`, ce qu'elle a compris et ce qu'elle ferait en premier. Elle ne prend aucun ticket ; ce qui a bougé reste pour les réveils suivants. `linear.sh list <état>` donne les tickets d'un état, pour vérifier une passation.

Pourquoi une minuterie du serveur et non une automatisation Orca : essayée le 7 octobre, celle-ci lance `claude --dangerously-skip-permissions` dans une session interactive qui ne se termine pas. Le modèle ne viendrait plus de la table, la liste blanche du rôle ne s'appliquerait pas, et la CLI ne rendrait aucun usage à écrire au ledger. Le pré-contrôle sans modèle et la lane stable visible dans Orca sont gardés.

```sh
ops/orchestration/wake.sh --dry-run    # dit ce qui a bougé, ne lance rien
```

## Discuter avec le chef de projet

`talk.sh` ouvre une conversation dans la lane `release/lead` d'Orca (onglet « discussion »). Le modèle est celui du rôle `[talk] role` de la table ; si le premier de la chaîne ne peut pas tenir de conversation, le suivant la prend. Avant le premier mot, le script lit l'état des lieux et le met dans le briefing : la machine et les PR ouvertes, ce qui attend l'utilisateur dans Linear, les derniers commentaires du ticket de suivi, les lanes au travail, la fin des trois derniers comptes rendus du chef de projet, les décisions déjà transcrites. `talk.sh --dry-run` affiche ce briefing sans rien ouvrir.

La session n'a aucun droit d'action (`[permissions.talk]`). Rien ne lui est demandé à l'écran : ce qui n'est pas nommé est refusé, pour qu'un « oui » de trop ne devienne pas une action. Elle lit les fichiers de la lane du chef de projet et de la copie des décisions, pas ailleurs, et jamais un fichier de secrets (`.env*`) ; elle n'a pas les outils de recherche, qui lisent partout dès qu'ils sont permis (essayé). Elle lit Linear (`linear.sh issue`, `comments`, `list`, `waiting`), `host-state.sh`, et l'historique du dépôt (`git log`, `git show`, `git ls-files`), sans les options de git qui écrivent un fichier ou en lisent un hors du dépôt.

Son seul pouvoir d'écriture est de proposer la transcription d'une décision que l'utilisateur a formulée, et rien ne part sans lui :

1. La session appelle `decide.sh <ticket> - [--adr]`. Le texte passe par le garde-fou et reste en attente dans `state/decisions/pending/`. Rien n'est envoyé.
2. L'utilisateur confirme lui-même, en tapant dans la conversation `! ops/orchestration/confirm-decision.sh` (ou depuis un autre terminal). La session n'a pas le droit de lancer ce script. `--list` montre ce qui attend, `--drop <numéro>` abandonne.
3. Alors seulement : avec `--adr`, la première confirmation montre tout ce qui change dans `docs/decisions.md`, lignes retirées comprises, et n'envoie rien ; la seconde valide ce changement, qui doit être resté celui de la proposition, et l'envoie en PR en brouillon (`push-lane.sh`) ; puis le texte est posté en commentaire du ticket, marqué comme écrit par un agent et confirmé par l'utilisateur ; puis une ligne `decision` est écrite au ledger, source `discussion` (`select at, ticket, detail from events where kind = 'decision'`). Dans cet ordre : ce qui ne peut pas partir arrête tout avant qu'on dise la décision prise, et relancer la confirmation reprend là où elle s'est arrêtée.

`docs/decisions.md` est le seul fichier que la session peut modifier, et dans une copie de travail à part (`talk-<ticket de suivi>`, branche `talk/<ticket de suivi>`) : la lane du chef de projet ne contient jamais de fichier modifié. À chaque discussion, `main` est ramenée dans cette branche ; une branche qui existe n'est jamais recommencée.

Jamais deux agents dans le même dossier : tant qu'une discussion est ouverte, les sessions courtes du chef de projet attendent (rien de ce qui bouge n'est perdu, elles le reçoivent ensuite), et `talk.sh` refuse d'ouvrir pendant qu'une session courte travaille. Fermer la conversation (`/exit`) les relance.

La conversation est écrite au ledger comme une session de source `discussion`, avec les tokens que son propre journal de session a comptés (inconnus, et non zéro, si le journal est introuvable). Son terminal n'est pas fermé par les réveils du chef de projet. Une décision transcrite ne réveille pas le chef de projet et ne vaut pas, pour lui, accord écrit : question ouverte, à l'utilisateur de trancher.

## Pousser une lane

Une lane n'a aucune commande réseau. Quand son run est terminé, `lane-run.sh` appelle `push-lane.sh` pour les rôles de `[lanes] push_roles` : il pousse la branche de la lane vers la branche du même nom, et ouvre sa PR en brouillon vers la branche de base. Rien d'autre : jamais forcé, jamais la branche de base, jamais une autre branche. Les messages de commit et ce que la branche ajoute passent d'abord par le garde-fou du dépôt ; refusés, rien ne part (un push ne se rattrape pas). Ce qu'une branche retire n'est pas jugé, et un fichier binaire n'est pas lu : le garde-fou ne connaît que le texte.

## Le ledger

`state/ledger.db` (SQLite), dans le checkout principal, hors de git, commun à toutes les lanes. Écrit par les scripts (`lib/ledger.mjs`), jamais par un modèle.

- `runs` : un lancement de modèle. `run_id`, `ticket`, `role`, `model`, `provider`, `started_at`, `ended_at`, `tokens_in`, `tokens_out`, `tokens_cache`, `cost_eur`, `outcome`, `pr_number`, `lines_changed`, `human_decision`, `human_latency_min`, et en plus `lane`, `source`, `requested_model`, `exit_code`, `tokens_cache_write`, `tokens_total`, `cost_basis`, `project`, `label`.
- `events` : `wake_skipped`, `monitor_expired`, `lane_limit_reached`, `prod_revert`, `model_fallback`, `model_fallback_failed`, `comment_handled` (délai, en minutes, entre un commentaire de l'utilisateur et la première action), `cli_outdated` (jours de retard d'une CLI), `orca_terminal_delayed` et `orca_terminal_failed` (Orca lent ou muet à l'ouverture d'un terminal).

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

## Les services du serveur

La page n'est lisible que depuis le réseau Tailscale (décision du 7 octobre) : les titres des tickets en attente y figurent, et rien de ce qui est à venir n'est public.

`serve/install.sh` installe, sans droits d'administrateur, sans conteneur et sans proxy :

- un service utilisateur, `serve/serve-dashboard.mjs`, à l'écoute sur la seule adresse Tailscale du serveur. Écouter là ne suffit pas, un conteneur de l'hôte atteint aussi cette adresse : le service refuse donc toute connexion dont la source n'est pas une machine du réseau Tailscale, et ne sert que la page ;
- une minuterie qui relance `dashboard.sh` toutes les dix minutes. Des scripts seulement, aucun modèle ;
- la minuterie du réveil du chef de projet, toutes les minutes ;
- la relecture, chaque heure, des sessions de l'ancienne organisation dans le ledger.

`serve/check.sh` vérifie qui peut lire la page : cette machine par Tailscale, oui ; un conteneur, non, par aucune adresse ; rien n'écoute ailleurs. `install.sh` le lance à la fin.

Tous appellent les scripts du checkout d'où `install.sh` a été lancé : le relancer depuis le checkout principal une fois la PR fusionnée.
