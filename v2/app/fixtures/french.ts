// The sample data in French (the project lead's review of #462, lane
// j6-ui-pro): the fixtures are written in English, which the tests read; a
// French page showing them mixed English sentences into French screens.
// `fixtureSource({ language: 'fr' })` passes every answer through `inFrench`,
// which replaces each sentence below wherever it stands, a whole value or
// inside one (a tool call's arguments are JSON in a string). Commands, paths,
// ids, names and the ticket states the screens translate themselves stay.
// Longer sentences are replaced first, so a sentence holding a shorter one is
// taken whole.
const PHRASES: readonly (readonly [string, string])[] = [
  // the lead
  ['Understood. I checked the decisions: entries are shown newest first (decision 3), and the page works without JavaScript (decision 1). Here is a plan in five tickets. Two are small enough for the fast lane. I need your go on the plan; you will still approve each release. When the first ticket lands, I will tell you how long it took from start to live.',
    'Compris. J\'ai vérifié les décisions : les entrées s\'affichent de la plus récente à la plus ancienne (décision 3), et la page marche sans JavaScript (décision 1). Voici un plan en cinq tickets. Deux sont assez petits pour la voie rapide. J\'ai besoin de votre feu vert sur le plan ; vous approuverez toujours chaque mise en production. Quand le premier ticket sera livré, je vous dirai combien de temps il a fallu du début à la mise en ligne.'],
  ['Before I plan: on desktop, do you want the entries in pages of 20, or one long list that loads more as you scroll, like on the phone?',
    'Avant de planifier : sur ordinateur, voulez-vous les entrées par pages de 20, ou une seule longue liste qui en charge davantage au défilement, comme sur le téléphone ?'],
  ["The owner asked for nothing new since the morning. The example's checks are green again; I told the owner. Nothing in progress.",
    'Rien de nouveau demandé depuis ce matin. Les contrôles de l\'exemple sont de nouveau au vert ; je l\'ai signalé. Rien en cours.'],
  ['Goal: make the guestbook readable once it has many entries. I want it before Friday.', 'Objectif : rendre le livre d\'or lisible quand il a beaucoup d\'entrées. Je le veux avant vendredi.'],
  ['Pages of 20. The phone keeps the long list.', 'Pages de 20. Le téléphone garde la longue liste.'],
  ['Pages of 20 (Recommended)', 'Pages de 20 (recommandé)'],
  ['One long list', 'Une seule longue liste'],
  ['When the first ticket of the plan lands, tell the owner how long it took from start to live.', 'Quand le premier ticket du plan est livré, dire combien de temps il a fallu du début à la mise en ligne.'],
  ['Tell the owner when the checks of the example are green again.', 'Prévenir quand les contrôles de l\'exemple repassent au vert.'],
  ['Told at 15:41: green after the lock file fix.', 'Prévenu à 15:41 : vert après la correction du fichier de verrouillage.'],
  ['Read the open tickets of the week and propose a plan for the ones that stalled.', 'Lire les tickets ouverts de la semaine et proposer un plan pour ceux qui stagnent.'],
  ['Read the error log of the night and open a ticket for each new error', 'Lire le journal d\'erreurs de la nuit et ouvrir un ticket par nouvelle erreur'],
  ['Refreshed from memory', 'Rechargé depuis la mémoire'],
  // the plans and their tickets
  ['Make a long guestbook readable', 'Rendre lisible un long livre d\'or'],
  ['Pages of 20 entries on desktop, the long list on the phone. Ready by Friday.', 'Pages de 20 entrées sur ordinateur, la longue liste sur le téléphone. Prêt pour vendredi.'],
  ['Show 20 entries per page on screens of 1024 px and more, with links to the next and previous pages.\n\nAcceptance criteria\n- [ ] 20 entries per page on desktop\n- [ ] the phone keeps the long list\n- [ ] a test of the second page',
    'Afficher 20 entrées par page sur les écrans de 1024 px et plus, avec des liens vers les pages suivante et précédente.\n\nCritères d\'acceptation\n- [ ] 20 entrées par page sur ordinateur\n- [ ] le téléphone garde la longue liste\n- [ ] un test de la deuxième page'],
  ['The next page continues where the previous one ended, newest first, even when an entry is added meanwhile.\n\nAcceptance criteria\n- [ ] no entry is shown twice or skipped across pages\n- [ ] a test that adds an entry between two pages',
    'La page suivante reprend là où la précédente s\'arrête, de la plus récente à la plus ancienne, même si une entrée est ajoutée entre-temps.\n\nCritères d\'acceptation\n- [ ] aucune entrée affichée deux fois ni sautée d\'une page à l\'autre\n- [ ] un test qui ajoute une entrée entre deux pages'],
  ['A guestbook with no entry shows “No entries yet” instead of an empty list.\n\nAcceptance criteria\n- [ ] the text on an empty guestbook\n- [ ] a test',
    'Un livre d\'or sans entrée affiche « Pas encore d\'entrée » au lieu d\'une liste vide.\n\nCritères d\'acceptation\n- [ ] le texte sur un livre d\'or vide\n- [ ] un test'],
  ["Group the entries under one heading per day, newest day first.\n\nAcceptance criteria\n- [ ] one heading per day, in the visitor's time zone\n- [ ] a test with entries on three days",
    'Regrouper les entrées sous un titre par jour, le jour le plus récent d\'abord.\n\nCritères d\'acceptation\n- [ ] un titre par jour, dans le fuseau horaire du visiteur\n- [ ] un test avec des entrées sur trois jours'],
  ['Add “entry” and “page” to the project glossary.\n\nAcceptance criteria\n- [ ] both terms in the glossary', 'Ajouter « entrée » et « page » au glossaire du projet.\n\nCritères d\'acceptation\n- [ ] les deux termes dans le glossaire'],
  ['Pages of 20 entries on desktop.\n\nAcceptance criteria\n- [ ] Pages of 20 entries on desktop, with a test.', 'Pages de 20 entrées sur ordinateur.\n\nCritères d\'acceptation\n- [ ] Pages de 20 entrées sur ordinateur, avec un test.'],
  ['A link back to the newest page.\n\nAcceptance criteria\n- [ ] A link back to the newest page, with a test.', 'Un lien pour revenir à la page la plus récente.\n\nCritères d\'acceptation\n- [ ] Un lien pour revenir à la page la plus récente, avec un test.'],
  ['Entries in two columns from 1024 px.\n\nAcceptance criteria\n- [ ] Entries in two columns from 1024 px, with a test.', 'Les entrées sur deux colonnes à partir de 1024 px.\n\nCritères d\'acceptation\n- [ ] Les entrées sur deux colonnes à partir de 1024 px, avec un test.'],
  ['The form stays visible while scrolling.\n\nAcceptance criteria\n- [ ] The form stays visible while scrolling, with a test.', 'Le formulaire reste visible au défilement.\n\nCritères d\'acceptation\n- [ ] Le formulaire reste visible au défilement, avec un test.'],
  ['Long names wrap instead of overflowing.\n\nAcceptance criteria\n- [ ] Long names wrap instead of overflowing, with a test.', 'Les noms longs passent à la ligne au lieu de déborder.\n\nCritères d\'acceptation\n- [ ] Les noms longs passent à la ligne au lieu de déborder, avec un test.'],
  ['Each entry shows the time it was written.\n\nAcceptance criteria\n- [ ] Each entry shows the time it was written, with a test.', 'Chaque entrée affiche l\'heure de son écriture.\n\nCritères d\'acceptation\n- [ ] Chaque entrée affiche l\'heure de son écriture, avec un test.'],
  ['Update {{package}} to {{version}}.\n\nAcceptance criteria\n- [ ] the tests pass\n- [ ] the lock file changes only for {{package}}', 'Mettre à jour {{package}} en {{version}}.\n\nCritères d\'acceptation\n- [ ] les tests passent\n- [ ] le fichier de verrouillage ne change que pour {{package}}'],
  ['Pages of 20 entries on desktop', 'Pages de 20 entrées sur ordinateur'],
  ['A link back to the newest page', 'Un lien pour revenir à la page la plus récente'],
  ['Day headings in the list of entries', 'Un titre par jour dans la liste des entrées'],
  ['An empty page says “No entries yet”', 'Une page vide dit « Pas encore d\'entrée »'],
  ['Entries in two columns from 1024 px', 'Les entrées sur deux colonnes à partir de 1024 px'],
  ['Page links keep the newest-first order', 'Les liens de page gardent l\'ordre du plus récent au plus ancien'],
  ['The form stays visible while scrolling', 'Le formulaire reste visible au défilement'],
  ['Long names wrap instead of overflowing', 'Les noms longs passent à la ligne au lieu de déborder'],
  ['Each entry shows the time it was written', 'Chaque entrée affiche l\'heure de son écriture'],
  ['The guestbook reads well on a wide screen.', 'Le livre d\'or se lit bien sur un grand écran.'],
  ['Glossary: “entry”, “page”', 'Glossaire : « entrée », « page »'],
  ['Entries on desktop', 'Entrées sur ordinateur'],
  ['Desktop list', 'Liste sur ordinateur'],
  ['The package to update', 'Le paquet à mettre à jour'],
  ['The version to reach; the latest when empty', 'La version visée ; la dernière si vide'],
  // the sessions and their tickets
  ['Upcoming: group entries by week', 'À venir : regrouper les entrées par semaine'],
  ['Glossary: add the “Fast lane” entry', 'Glossaire : ajouter l\'entrée « Voie rapide »'],
  ['Bank sync: retry once before failing', 'Synchro bancaire : réessayer une fois avant d\'échouer'],
  ['Envelope sheet shows its previous months', 'La fiche d\'enveloppe montre ses mois précédents'],
  ['Stale figures no longer survive two crossing reads', 'Des chiffres périmés ne survivent plus à deux lectures croisées'],
  ['Running the docs tests · 12 passed so far', 'Lance les tests de la doc · 12 réussis pour l\'instant'],
  ['Writing a test for a timeout on the bank API', 'Écrit un test pour un délai dépassé sur l\'API bancaire'],
  ['Waiting for your permission to install date-fns', 'Attend votre autorisation pour installer date-fns'],
  ['Reading the diff of src/screens/Envelope.jsx', 'Lit le diff de src/screens/Envelope.jsx'],
  ['Reading src/screens/Envelope.jsx', 'Lit src/screens/Envelope.jsx'],
  ["Each envelope's sheet shows the months before this one, so a person sees where the money went.\n\n- [x] The three months before this one, newest first\n- [x] A new envelope shows none\n- [ ] The sheet at 390 keeps one column",
    'La fiche de chaque enveloppe montre les mois d\'avant, pour voir où est passé l\'argent.\n\n- [x] Les trois mois précédents, du plus récent au plus ancien\n- [x] Une nouvelle enveloppe n\'en montre aucun\n- [ ] La fiche à 390 garde une seule colonne'],
  ['The sheet lists the three months before this one, newest first, under a History heading. A new envelope shows none.', 'La fiche liste les trois mois précédents, du plus récent au plus ancien, sous un titre Historique. Une nouvelle enveloppe n\'en montre aucun.'],
  ['The envelope list reads one section at a time', 'La liste des enveloppes se lit une section à la fois'],
  ['Call the section Previous months, as the ticket says.', 'Appeler la section Mois précédents, comme le dit le ticket.'],
  ['Install date-fns to group dates by week', 'Installer date-fns pour regrouper les dates par semaine'],
  ['Apply the new migration to the test database', 'Appliquer la nouvelle migration à la base de test'],
  ['Network access and a new dependency.', 'Accès au réseau et nouvelle dépendance.'],
  ['The command is not on the list of safe commands.', 'La commande n\'est pas dans la liste des commandes sûres.'],
  ['git merge-base main HEAD is not a command the policy allows on its own', 'git merge-base main HEAD n\'est pas une commande que la politique autorise seule'],
  ['Run the docs tests', 'Lancer les tests de la doc'],
  ['Running the tests', 'Lance les tests'],
  ['Run the tests', 'Lancer les tests'],
  ['Reading the branch', 'Lit la branche'],
  ['Read the branch', 'Lire la branche'],
  ['Commit the change', 'Valider le changement'],
  ['not in the fixtures', 'absent des données d\'exemple'],
  // the inbox
  ['“Comings and goings” replaces “Departures and arrivals”', '« Allées et venues » remplace « Départs et arrivées »'],
  ['The list of upcoming movements is now titled “Comings and goings”.', 'La liste des prochains mouvements s\'intitule désormais « Allées et venues ».'],
  ["The archive page reuses the list's heading: a heading changes in both templates.", 'La page d\'archive reprend le titre de la liste : un titre change dans les deux gabarits.'],
  // a question to the code
  ['What does line 12 of the page do, and which function calls it?', 'Que fait la ligne 12 de la page, et quelle fonction l\'appelle ?'],
  ['Line 12 builds the ESCAPES table (guestbook/src/page.ts:12): the five characters HTML gives a meaning to, each with its entity. escapeHtml (guestbook/src/page.ts:20-24) reads it to escape a name and a message before the page writes them, so an entry cannot add markup to the page.',
    'La ligne 12 construit la table ESCAPES (guestbook/src/page.ts:12) : les cinq caractères auxquels HTML donne un sens, chacun avec son entité. escapeHtml (guestbook/src/page.ts:20-24) la lit pour échapper un nom et un message avant que la page les écrive, si bien qu\'une entrée ne peut pas ajouter de balises à la page.'],
  ['Which test file covers that function?', 'Quel fichier de test couvre cette fonction ?'],
  ['guestbook/test/page.test.ts:31: "an entry with markup is escaped" posts a name with a <script> tag and checks the page shows it as text.', 'guestbook/test/page.test.ts:31 : « an entry with markup is escaped » publie un nom avec une balise <script> et vérifie que la page l\'affiche comme du texte.'],
  ['Where does the guestbook call the filter API, and what does it do when the call fails?', 'Où le livre d\'or appelle-t-il l\'API de filtrage, et que fait-il quand l\'appel échoue ?'],
];

const ORDERED = [...PHRASES].sort((a, b) => b[0].length - a[0].length);
// A sentence inside a JSON string is escaped: its quotes and its new lines as JSON writes them.
const escaped = (text: string) => JSON.stringify(text).slice(1, -1);

function replace(value: string): string {
  let out = value;
  for (const [en, fr] of ORDERED) {
    if (out.includes(en)) out = out.split(en).join(fr);
    else {
      const inner = escaped(en);
      if (inner !== en && out.includes(inner)) out = out.split(inner).join(escaped(fr));
    }
  }
  return out;
}

// Every string of a value, deep, in French where a sentence above stands.
export function inFrench<T>(value: T): T {
  if (typeof value === 'string') return replace(value) as T;
  if (Array.isArray(value)) return value.map((item) => inFrench(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inFrench(item)])) as T;
  return value;
}
