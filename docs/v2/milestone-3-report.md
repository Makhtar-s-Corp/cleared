# Jalon 3 : rapport pour le PO

## De quoi on parle

Cleared v2 prend un ticket, le confie à des agents de code, et vous rend une pull request prête à relire, avec la preuve que ça marche. Ce jalon ajoute dix idées produit, corrige ce que les relectures ont trouvé, et polit les écrans avant que `v2` rejoigne `main`. Tout a été construit et testé sur des comptes factices : aucun vrai compte Claude Code, Codex, Cursor ou Slack, aucun Docker, aucun tunnel.

## Ce qui est livré

| Idée | Ce que vous voyez | Ligne de matrice |
|---|---|---|
| Reçu de preuve | En tête de chaque PR : captures avant/après, courte vidéo du parcours, tests lancés, coût | P210 |
| Coût par ticket | Jetons et durée sur la carte du ticket et dans la PR ; euros ou dollars seulement depuis une vraie source | P211 |
| Ticket depuis le chat | Une commande `@cleared <tâche>` crée le ticket et renvoie le lien de la PR (testé avec un faux chat) | P212 |
| Choix automatique de l'agent | Plusieurs agents en parallèle, on garde la PR verte la plus économe, avec des statistiques par type de ticket | P213 |
| Modèles de ticket | Bug, Revue, CI, Question | P214 |
| Questions sur le code | Les réponses citent le code avec de vrais liens GitHub, jamais inventés | P215 |
| Agents locaux connectés | Un agent local voit les lanes en cours et les fichiers verrouillés avant d'éditer | P216 |
| Interface mobile | Boîte de réception, Go et merge utilisables à 375 px | P217 |
| Vérification après mise en prod | Après votre accord, une capture de la page de production rejoint le rapport ; Cleared ne déploie jamais | P218 |
| Moins de jetons | Prompts stables et outils groupés pour le cache, mesuré avant/après | P219 |

S'y ajoutent :
- la voie rapide (B2.2) ;
- les compétences chargées depuis votre profil seulement (B5.5b, choix A) ;
- les correctifs de sécurité et de démarrage issus des relectures (#347 à #353) ;
- un test instable réparé (#360) ;
- une passe de relecture de la documentation (P221) ;
- une passe de polissage des écrans (P222), avec captures avant/après dans `docs/v2/ui-polish/`, compressées de 11,3 Mo à 4,0 Mo.

## Comment c'est vérifié

Chaque changement est passé par :
- une pull request vers `v2` ;
- deux relectures indépendantes, plus une relecture après chaque fusion de `v2` dans la branche ;
- une CI verte ;
- un merge commit, sans réécriture d'historique.

Les tests d'un changement sont écrits d'abord et échouent sur l'ancien code. Ce jalon compte environ 2100 tests Node et 340 tests Vitest, sans échec. La matrice `docs/v2/requirements-matrix.md` garde chaque identifiant une seule fois, et `docs/v2/decisions-log.md` explique chaque choix.

## Ce qui continue sans vous

Trois lanes de finition tournent sur `v2`, sans nouvelle fonctionnalité :
- la vitesse des changements d'onglet ;
- l'accessibilité (WCAG 2.2 AA) ;
- les trous de couverture de tests, avec deux tests instables en CI.

Viennent ensuite :
- une refonte visuelle de la navigation, de la Session, de la Réception et de la Consommation ;
- la détection automatique des tickets qui ont besoin de captures (issue #368).

## Ce qui vous attend

- Donner votre accord pour un premier vrai ticket à faible risque (B6.1q).
- Valider les notifications sur Mac (B5.10g, D21).
- Lancer les essais réels avec Codex et Cursor (D13, B5.1c, O6, P69).
- Faire la vraie passation (B6.3p) et confirmer le quota réel (P71).
- Confirmer les points de l'orchestrateur (B3.10, P7).
- Lancer les preuves en conditions réelles : j2 sur 48 h, j2 multi-dépôts, P47, P51.
- Trancher la question des passkeys de la v1, reportée au jalon 4.
