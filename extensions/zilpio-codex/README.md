# Zilpio Codex

Estensione inclusa in ZilpioStudioCode. Usa il binario ufficiale Codex App Server e non richiede dipendenze npm proprie.

## Uso

1. Apri una cartella locale e autorizza il workspace.
2. Il pulsante **Codex · profilo** compare in basso a destra. Il menu permette di selezionare, creare e collegare ambienti e di aprire il JSON.
3. **Zilpio: Apri Codex** apre la chat. **Storico** riapre le conversazioni dello stesso archivio.
4. Cambia profilo fra turni. Se Codex sta lavorando, premi **Interrompi** e attendi che il turno termini.

Il comando **Collega account** supporta accesso ChatGPT nel browser oppure chiave API tramite un campo protetto.

## Dati

### ZilpioAgents nel pannello ufficiale

Tasto destro su una chat locale, anche nel menu **Recent chats**, poi **Crea ZilpioAgent**. Il dialogo propone nome univoco e colore casuale modificabili. La sezione richiudibile **ZilpioAgents** resta in cima al pannello; il nome e l'icona colorata sostituiscono il titolo nella presentazione. Il titolo originale resta nello storico e nel tooltip dell'agente. Tasto destro sull'agente permette **Modifica agente**, **Elimina agente** e l'archiviazione della chat quando disponibile. Eliminare l'agente conserva la conversazione e rimuove la reference.

Nelle altre chat scrivi `@Nome`: il completamento propone gli agenti del progetto e dell'environment attivi. Esempio: `Chiedi a @Elio di controllare questi errori e riportami il risultato`. Codex usa i tool MCP `list_agents` e `send_message` per risolvere i nomi e inviare richieste alle chat esistenti, senza creare subagenti sostitutivi. Gli incarichi attendono in coda se il destinatario è occupato; la chiamata resta in attesa e restituisce il risultato finale direttamente al turno di chi ha delegato, che puo proseguire e rispondere all'utente. Nella sezione agenti compare lo stato "In attesa di Nome". Nel destinatario la richiesta indica il nome del mittente e si aggiunge alla conversazione già presente. Le normali approvazioni Codex restano attive. La menzione identifica il destinatario: l'agente orchestratore sceglie quando chiamare il tool, non viene inviato automaticamente ogni testo contenente `@`.

Il registro `agents.json` si trova accanto a `profiles.json`: ID stabili, nomi riservati anche dopo rinomina/eliminazione, cartella del progetto e colori. I nomi sono univoci nel registro Zilpio, anche fra environment. Elenco, completamento e messaggistica includono solo gli agenti della cartella di progetto aperta e dello stesso environment; cartelle annidate aperte come progetti distinti restano separate. Gli agenti precedenti senza cartella vengono associati alla directory della loro conversazione quando il relativo environment è disponibile, conservando nome, ID e storico. I collegamenti tra finestre/processi distinti e host remoti non sono inclusi. Account ed environment non possono cambiare mentre ci sono incarichi pendenti. Se la connessione Codex cade, gli incarichi in memoria vengono segnalati come interrotti e non vengono ritentati automaticamente.

Dopo l'aggiornamento riavvia Zilpio tramite **`ZSCode.exe`** e riapri le chat da usare. Il server MCP locale viene aggiunto alla creazione, incluso il preavvio delle nuove chat, e alla ripresa dei thread esistenti, senza riscrivere lo storico o la configurazione globale Codex. Gli agenti gi? creati non devono essere ricreati.

Verifica mirata: `node --test scripts/tests/zilpio-agents.test.cjs`, `node scripts/tests/zilpio-agents-ui.cjs`, `node scripts/tests/zilpio-agents-protocol.cjs` e `node --disable-warning=ExperimentalWarning scripts/tests/zilpio-agents-runtime.cjs`. La prova protocollo usa il binario reale con modello e credenziali simulati locali, riprende una chat preesistente, riattiva automaticamente un worker scaricato e verifica il ritorno del risultato. La prova runtime usa un profilo editor temporaneo e verifica il vero menu Codex, CRUD, colori e completamento ProseMirror.

La cartella globalStorage dell'estensione contiene:

- `profiles.json`: nomi, provider, percorsi assoluti degli account e ID selezionato; nessuna credenziale.
- `storage-migration.json`: stato della migrazione e copie dei registri precedenti, senza credenziali.
- `runtime/`: storico persistente dei thread gestito da Codex, indipendente dall'account selezionato. L'autenticazione del runtime e effimera.
- `history.json`: indice delle chat e profilo usato per ogni turno; nessun token.

`profiles.example.json` incluso nei sorgenti è il modello generico per il primo avvio. Un eventuale `profiles.json` accanto al modello è personale, escluso da Git e ha precedenza per l'importazione iniziale. I registri già salvati nei dati dell'app mantengono i propri account. Modificare il registro tramite **Modifica JSON profili**. Provider inizialmente supportato: `openai`, sia ChatGPT che API. Altri provider non sono implementati.

Gli account risiedono in `~/.codex-account/<account>/` e conservano soltanto `auth.json`. Il worker di autenticazione usa una cartella temporanea separata e riporta nel profilo solo le credenziali aggiornate; database e cache temporanei vengono eliminati dopo la chiusura del worker. Le operazioni sullo stesso account vengono serializzate. Gli access token ChatGPT vengono consegnati in memoria al runtime. Le chiavi API usano il login App Server con archivio credenziali effimero. I token non attraversano la webview.

## Limiti della prima versione

- Un'unica finestra puo gestire il runtime Codex per volta: impedisce scritture concorrenti nello storico e cambi account su turni di altre finestre.
- Storico delle nuove chat Zilpio; non importa automaticamente chat pregresse dalle cartelle account.
- Chat testuale, output del terminale, diff e approvazioni native. Allegati e tutte le funzionalita dell'estensione proprietaria OpenAI non sono replicati.
- La continuita API e stata verificata con due identita fittizie, due risposte locali e il binario Codex reale. Lo switch tra account ChatGPT reali richiede una prova interattiva dopo la scelta degli account.
- I profili selezionano l'autenticazione; la configurazione operativa Codex e comune in `runtime/config.toml`. Non trasferisce automaticamente config, skill o MCP dalle cartelle account.

## Verifica

```powershell
.build/tools/node.exe --test scripts/tests/zilpio-*.test.cjs
.build/tools/node.exe scripts/tests/zilpio-appserver-smoke.cjs C:/percorso/codex.exe
```

La verifica App Server usa soltanto un server HTTP locale, credenziali fittizie e una cartella temporanea: nessuna inferenza reale.

## Avvio

La build autonoma usa `scripts/zilpio.ps1`. La compilazione iniziale e bloccata da `MSB8040`: mancano le librerie MSVC v143 x64/x86 con mitigazione Spectre nell'installazione Visual Studio 2022. Installare quel componente tramite Visual Studio Installer, poi ripetere `npm ci` usando Node 24.18.0.

Per provare subito l'integrazione: `AvviaAnteprima.bat`. L'anteprima usa la copia ufficiale separata in `.build/clean-host`, con dati utente separati e aggiornamenti disattivati. L'estensione ufficiale `openai.chatgpt` e stata inclusa localmente dalla versione gia presente sul PC; si apre all'avvio. Il launcher include anche questa estensione Zilpio fra le estensioni integrate, senza modalita sviluppo.

Quando l'estensione ufficiale e inclusa, il pannello sperimentale non si apre automaticamente e il suo menu nella barra di stato e nascosto. I comandi **Zilpio:** restano disponibili per lo sviluppo e riguardano solo il pannello sperimentale. Questa anteprima non e la build autonoma del fork e non modifica l'installazione VS Code esistente.

Il selettore **Account** accanto a **Work locally** usa il registro JSON Zilpio anche nel pannello ufficiale. Le credenziali sono lette e aggiornate da un helper in una cartella temporanea separata e passate al processo ufficiale soltanto nel lato host. Il processo ufficiale usa autenticazione effimera; storico e configurazione dipendono dal selettore **Environment** descritto sotto. Il cambio account invia `account/login/start` al processo esistente; non avvia o riprende un altro thread. Turni in corso bloccano il cambio. La selezione viene salvata solo dopo il login riuscito; un errore di scrittura ripristina l'account precedente. Il menu permette anche di creare un account vuoto, collegarlo via browser o chiave API e aprire il registro JSON.

Verifica: bootstrap di un profilo reale nel processo ufficiale, elenco di 7 profili e quote lette dopo l'autenticazione; test di blocco durante i turni e ripristino su errore. Una conversazione reale continuata fra due account diversi richiede ancora una prova interattiva: non e stata effettuata inferenza per questa verifica.

### Notifier integrato

Zilpio Codex Notifier (`zilpio.codex-notifier-telegram`, versione 0.0.7, MIT) e incluso in `extensions/zilpio-codex-notifier` dal VSIX del progetto locale `CodexNotifier`. Il launcher lo include tra le estensioni integrate, senza installazione manuale dal Marketplace. Mantiene il proprio identificativo e le impostazioni `codexNotifierTelegram.*`. La campanella laterale e l'ingranaggio nel titolo Codex aprono il pannello di configurazione. Il rilevatore segue il log dell'estensione ufficiale nella finestra ZSCode; e indipendente dal percorso dello storico e dall'account selezionato. Telegram e disattivato finche l'utente non lo configura nel pannello.

### Controlli nel pannello ufficiale

Le chat Codex locali e gli ZilpioAgents disponibili si possono trascinare dall'elenco nell'area editor: al centro si aprono come schede, sui bordi creano gruppi affiancati. Il menu della chat offre anche **Apri in scheda**. Le schede sono fissate e usano l'editor conversazioni nativo Codex, con storico e aggiornamenti della propria chat. Chiudere una scheda non elimina la conversazione. Aprire un agente da una scheda conserva la conversazione originale e apre o richiama la scheda dell'agente.

Verifiche mirate: `node --test scripts/tests/zilpio-chat-tabs.test.cjs`, `node scripts/tests/zilpio-agents-ui.cjs` e `node --disable-warning=ExperimentalWarning scripts/tests/zilpio-chat-tabs-runtime.cjs`. La prova runtime usa due chat temporanee, modello locale simulato e rilascio nativo dei dati di trascinamento nell'editor isolato.

Accanto a **Modelli**, **Environment** seleziona l'archivio delle chat: **Work** usa `~/.codex-work`, **Codex** usa `~/.codex`. La scelta resta salvata tra gli avvii. **Modifica impostazioni…** apre `environments.json` nella stessa cartella di `profiles.json`: modifica `name` per il nickname e `home` per il percorso assoluto della cartella Codex (non della sottocartella `sessions`). Il registro usa lo stesso formato degli account: `version`, `activeProfileId`, `profiles`.

Il cambio environment, consentito solo senza turni attivi, apre una nuova chat e ricarica la finestra. Il processo ufficiale legge configurazione, skill e storico dalla cartella scelta; gli account continuano a essere selezionati separatamente. Nessuna chat viene copiata o spostata. Al salvataggio del JSON, cambiare solo il nickname aggiorna il menu; cambiare la cartella attiva o l'ID selezionato ricarica la finestra.

`scripts/patch-official-codex.cjs` include una piccola aggiunta JS/CSS nel pannello ufficiale, verificando la versione `26.1007.21434`. Il launcher riapplica la modifica in modo idempotente e si ferma su versioni diverse. I menu nativi di modello e permessi ricevono etichette esplicite; i loro eventi e le loro impostazioni restano quelli ufficiali.

Le due barre leggono `account/rateLimits/read` tramite il processo ufficiale gia attivo e ascoltano `account/rateLimits/updated`. Si aggiornano ogni minuto mentre il pannello e visibile e al cambio account. Mostrano `100 - usedPercent` per finestre di 300 e 10080 minuti; valori mancanti sono indicati come non disponibili. Verde oltre 50%, giallo dal 21% al 50%, rosso al 20% o meno. Il tooltip mostra il ripristino quando fornito dal server. Nessuna credenziale viene letta da questa aggiunta, nessuna richiesta di inferenza viene effettuata.

Verifica effettuata nel pannello reale: bridge caricato, entrambe le quote ricevute, barre montate, etichette modello e permessi applicate. Test mirati: `scripts/tests/zilpio-usage.test.cjs`.

### Struttura account ed environment

- `~/.codex`: ambiente originale Codex, compresa la sua autenticazione. Zilpio non lo sposta n? lo modifica durante la migrazione.
- `~/.codex-account/<account>/auth.json`: autenticazione degli account Zilpio. Il lock dell?helper esiste solo durante un?operazione; non vengono conservati database, skill o storico.
- `~/.codex-work`: configurazione, skill, plugin, chat e stato dell?Environment Work. Nessun `auth.json`.
- `~/.codex-<nome>`: nuovi Environment creati dal menu **Environment ? Nuovo environment?**. Il nome viene convertito in minuscolo e gli spazi in trattini; una cartella gi? esistente non viene sovrascritta. Rinominare il nickname nel registro non sposta la cartella.

Al primo avvio aggiornato tramite `ZSCode.exe`, il launcher richiede la chiusura di tutte le finestre Zilpio. Copia solo l?autenticazione dalle vecchie cartelle account, sposta `.codexchathistory-zscode` in `.codex-work`, aggiorna i percorsi assoluti dei rollout nei database e nella configurazione e aggiorna i registri conservando gli ID e i riferimenti di workspace e agenti. L?account Default ottiene una copia del login originale sotto `.codex-account/default`; il login originale resta in `.codex`. Le destinazioni occupate bloccano la migrazione. Un `auth.json` presente in un Environment Zilpio va trasferito in un account prima di procedere; non viene eliminato automaticamente.

`storage-migration.json` conserva i registri precedenti e il piano di spostamento: una migrazione interrotta viene ripresa al prossimo avvio. Le vecchie cartelle account rimangono come copie di sicurezza, senza essere pi? utilizzate da Zilpio. Non cancellarle prima di aver verificato login e storico. Se un vecchio profilo usava esclusivamente il portachiavi di sistema e non possiede `auth.json`, occorre ricollegarlo nella nuova cartella.

Per tornare alla vecchia versione, chiudere Zilpio, ripristinare `profilesBefore`, `environmentsBefore` e, se presente, `agentsBefore` dal journal nei rispettivi JSON e riportare le cartelle indicate da `moves` ai percorsi `source`. Per ciascuno spostamento invertire anche i riferimenti interni chiamando `relocateEnvironmentPaths(source, target, source)` dal modulo `storage-migration.js` dopo lo spostamento fisico. Per i token nel frattempo aggiornati usare le credenziali correnti della nuova cartella account; non sovrascrivere l?autenticazione dell?app originale. Archiviare il journal prima di una successiva nuova migrazione.

Verifica: `node --test scripts/tests/zilpio-storage.test.cjs`. Include login API locale con il binario reale, persistenza limitata ad `auth.json`, autenticazione effimera nell?Environment, refresh serializzati, conflitti e ripresa dopo un errore nel salvataggio dei registri. La prova di riapertura crea un turno con un server modello simulato locale; non esegue inferenza remota n? usa account reali.

Nota di verifica: la suite generale `zilpio-agents.test.cjs` ? stata interrotta perch? il test di routing rimane in attesa usando il precedente contratto di `send`. Il test mirato di migrazione degli agenti usa il vero `AgentStore` e verifica conservazione di ID, nome, thread e progetto.
