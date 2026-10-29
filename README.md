# ZilpioStudioCode

ZilpioStudioCode è un progetto indipendente basato sul codice open source [Code - OSS](https://github.com/microsoft/vscode), il repository da cui nasce Visual Studio Code. Non è un prodotto Microsoft e non è affiliato a Microsoft o OpenAI.

Il progetto sperimenta un editor per Windows con integrazione Codex, profili e ambienti separati, gestione dei workspace, ZilpioAgents e una vista Trello. È in sviluppo: il repository contiene sorgenti e strumenti di sviluppo, non una release autonoma pronta per l'installazione.

## Stato e avvio

La base upstream è il tag Code - OSS 1.141.0. Per i prerequisiti e la compilazione di Code - OSS consulta la [guida upstream](https://github.com/microsoft/vscode/wiki/How-to-Contribute). Lo script `scripts/zilpio.ps1` avvia l'editor dai sorgenti con directory di dati separate.

L'anteprima locale (`AvviaAnteprima.bat` e `scripts/preview-zilpio.ps1`) dipende da strumenti e componenti preparati separatamente in `.build/`, che non sono inclusi nel repository. In particolare usa una copia della distribuzione Microsoft e una versione specifica dell'estensione ufficiale Codex, modificata localmente: non è una build autonoma e questi componenti sono soggetti alle rispettive licenze e condizioni. Non redistribuirli senza verificare i relativi diritti. Il launcher `ZSCode.exe` è un artefatto generato localmente e non è incluso.

Il notifier in `extensions/zilpio-codex-notifier` include il proprio sorgente. Per compilarlo, dalla sua cartella esegui `npm ci` seguito da `npm run compile`; `npm test` compila ed esegue i test. Gli output generati `dist/` sono esclusi da Git.

## Estensioni e servizi

Il Visual Studio Marketplace di Microsoft non è disponibile per prodotti alternativi basati su fork di Code - OSS secondo le [FAQ ufficiali](https://code.visualstudio.com/docs/supporting/faq). Le estensioni e i servizi di terze parti possono avere licenze e condizioni proprie. L'accesso a Codex, Trello e altri servizi richiede configurazione e account separati.

## Configurazione personale

Le impostazioni personali restano locali: `.vscode/settings.json`, `extensions/zilpio-codex/profiles.json`, `scripts/preview-zilpio.local.ps1` e `.build/` sono esclusi da Git. I registri esistenti degli account, degli ambienti e dei workspace mantengono i propri valori. Non inserire credenziali nei sorgenti o nei file di esempio.

Un nuovo clone usa `extensions/zilpio-codex/profiles.example.json` come configurazione iniziale; è possibile copiarlo in `profiles.json` per personalizzare gli account importati. Le impostazioni di sviluppo generiche sono disponibili in `.vscode/settings.example.json`. Lo script opzionale `scripts/preview-zilpio.local.ps1` permette di impostare `CODEX_HOME` e `zilpioNotifierPublisher` soltanto per la propria anteprima locale.

## Licenze

Il codice di Code - OSS e le modifiche del fork sono distribuiti sotto la [licenza MIT](LICENSE.txt). Conservare gli avvisi di copyright e licenza e consultare [ThirdPartyNotices.txt](ThirdPartyNotices.txt) per i componenti di terze parti. Il notifier conserva la [propria licenza MIT e attribuzione](extensions/zilpio-codex-notifier/LICENSE.md); la provenienza degli asset aggiunti è documentata in [FORK-NOTICES.md](FORK-NOTICES.md). Marchi e loghi appartengono ai rispettivi titolari.
