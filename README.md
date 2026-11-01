# FLAC Bridge Multi 2.3.0 — avvio e rinnovo circa ogni 6 ore

Questa versione conserva Tidal, Qobuz, Deezer e Amazon Music e aggiunge un controllo automatico all'avvio e tentativi periodici di rinnovo delle sessioni. **È un tentativo, non una garanzia che il servizio accetti la richiesta o che la sorgente riproduca audio.**

## Installazione e attivazione

1. In Myspoti → **Impostazioni → Estensioni → Installa da un file**, scegli questo ZIP **senza estrarlo** e accetta l'aggiornamento. Non disinstallare FLAC Bridge Multi e non cancellare i dati: le sessioni già salvate dovrebbero rimanere.
2. Controlla che sia attiva sia **l'estensione** sia l'interruttore **Verifica automatica all’avvio**. L'aggiornamento non può cambiare un interruttore che hai disattivato in Myspoti.
3. Se in precedenza hai usato **Cancella tutte le sessioni**, premi una volta **Riprova verifica automatica** per togliere la sospensione dovuta alla cancellazione. Questo comando non annulla eventuali attese HTTP 429.
4. Nel **Registro** cerca `Avvio: controllo automatico ...` e poi `Controllo automatico: rete disponibile ...`. Se la rete non è disponibile, il lavoro aspetta una connessione convalidata. Se una pausa è attiva, il Registro lo segnala invece di avviare la rete. Una pagina di verifica può richiedere il tuo intervento.

## Che cosa fa il controllo

- All'avvio controlla le sessioni salvate. Se sono recenti e non prossime alla scadenza, le conserva senza riaprire inutilmente la pagina. Se mancanti o rifiutate, avvia la verifica necessaria in sequenza, una pagina alla volta.
- Per le sessioni esistenti, tenta un **rinnovo ogni circa 6 ore** dall'ultima verifica o richiesta di rinnovo accettata; può tentarlo anche prima se una sessione si avvicina alla scadenza. Su un aggiornamento da versioni precedenti senza data dell'ultimo controllo, il rinnovo può essere tentato al primo avvio. Non cancella una sessione solo per un 429 o un errore temporaneo.
- Myspoti non offre un timer per le estensioni: il controllo periodico viene valutato dalle sue chiamate di stato, circa ogni cinque minuti **mentre l'app è visibile o sta riproducendo**. Può essere in ritardo; con l'app chiusa non è garantito. Alla successiva apertura o attività il controllo riprende.
- Il server può rifiutare il rinnovo, richiedere una verifica umana o imporre un'attesa HTTP 429. La verifica automatica rispetta l'attesa memorizzata e non garantisce il funzionamento dell'audio. Dopo una pagina chiusa o non completata, i tentativi automatici sono sospesi per circa 6 ore; **Riprova verifica automatica** può riprendere la sequenza, nel rispetto del 429.

## Controlli manuali e attese

**Mostra tempi di attesa** visualizza nel Registro le pause memorizzate, senza contattare il server. **Attiva Tidal/Qobuz/Deezer/Amazon** rispettano l'attesa indicata dal server. **Forza verifica manuale** può inviare un solo tentativo per la **Prima sorgente** prima della scadenza memorizzata; il server può comunque rispondere 429. Una richiesta anticipata potrebbe prolungare la limitazione: non ripeterla continuamente. È previsto un intervallo di sicurezza di 30 secondi tra tentativi manuali e non si apre una seconda pagina mentre ce n'è già una.


# FLAC Bridge Multi per Myspoti

Adattatore indipendente, non ufficiale, per Myspoti **2.1.0 o successivo**. Integra i protocolli di Tidal, Qobuz, Deezer e Amazon Music usati dalle estensioni SpotiFLAC Mobile/Mornye. **Le quattro fonti non sono garantite né equivalenti:** Deezer e Amazon hanno una limitazione importante descritta sotto.

## Aggiornamento e installazione

1. Scarica lo ZIP **senza estrarlo**. Apri Myspoti → **Impostazioni → Estensioni → Installa da un file** e selezionalo. Se hai già FLAC Bridge Multi, installalo come aggiornamento: mantiene lo stesso ID e le sessioni locali esistenti dovrebbero restare disponibili. Se presente, disattiva **MonoFLAC**.
2. La **verifica automatica** è attiva per impostazione predefinita. Quando l'estensione si avvia e il dispositivo è online, controlla le sessioni di **Tidal, Qobuz, Deezer e Amazon Music**. Le sessioni recenti vengono conservate; quelle il cui rinnovo è dovuto o che sono vicine alla scadenza vengono rinnovate se possibile. Per le sessioni mancanti o non più valide, avvia le verifiche necessarie **una alla volta**.
3. La pagina di verifica parte inizialmente nascosta. Se il server conclude da solo, non devi fare nulla. Se serve il tuo intervento, Myspoti mostra la stessa pagina dopo circa 8 secondi: completa l'eventuale CAPTCHA o altra richiesta. La verifica non viene aggirata e una fonte può restare non disponibile se il server non risponde.
4. In **FLAC Bridge Multi → Impostazioni → Prima sorgente** scegli la preferita. In **Impostazioni → Riproduzione → Sorgenti audio**, metti FLAC Bridge Multi prima di Spotify. Per i download, attivalo anche in **Impostazioni → Download → Sorgenti di download**.
5. Prova un brano, ad esempio «Yellow» dei Coldplay. La riga della qualità nel player indica la sorgente scelta se Myspoti usa l'estensione. Myspoti può tornare a Spotify quando non riceve un FLAC utilizzabile.

Non sono richiesti account Tidal, Qobuz, Deezer o Amazon da inserire nell'estensione. Le verifiche sono pagine del servizio esterno: **non inviare password, token o link della verifica in chat**. Se la pagina non si apre, chiudi eventuali altre pagine di accesso e aggiorna Android System WebView e Chrome; Myspoti richiede una WebView con supporto ai profili multipli.

## Verifica automatica e controlli manuali

- Se il telefono è offline all'avvio, la sequenza aspetta una connessione convalidata. La validità delle sessioni viene inizialmente controllata dai dati salvati; se il server revoca una sessione prima della scadenza, la richiesta successiva può avviare un nuovo controllo automatico.
- Se chiudi una pagina, il suo callback non è valido oppure la verifica scade, la sequenza si ferma senza aprire subito altre pagine. I tentativi automatici vengono sospesi per circa sei ore. Puoi chiedere prima **Riprova verifica automatica**: resta valido qualsiasi limite HTTP 429. Per indisponibilità del server o della WebView la sospensione può essere più breve.
- Se desideri verificare soltanto alcune fonti, disattiva **Verifica automatica all’avvio** e usa i pulsanti **Attiva Tidal**, **Attiva Qobuz**, **Attiva Deezer** e **Attiva Amazon Music**. Una pagina già aperta non viene chiusa dall'interruttore: completala o chiudila.
- **Riprova verifica automatica** riprende il controllo delle fonti mancanti, scadute o rifiutate e può rinnovare le sessioni anche ancora valide se il rinnovo è dovuto o si avvicina la scadenza. Gli errori temporanei non cancellano la sessione precedente. Dopo HTTP 429 rispetta la pausa anche se il pulsante viene premuto prima. Non è un test di riproduzione di tutte le fonti. Per usarlo, l'interruttore automatico deve essere attivo.
- **Cancella tutte le sessioni** elimina le sessioni locali e sospende la verifica automatica anche dopo il riavvio. Per riprenderla, premi **Riprova verifica automatica**, oppure disattiva e riattiva l'interruttore. I singoli pulsanti manuali restano disponibili. Una pagina già aperta può rimanere visibile, ma il suo eventuale risultato viene ignorato dopo la cancellazione.

## Come funzionano le fonti

| Fonte | Supporto in questa versione |
|---|---|
| **Tidal** | Richiesta lossless; FLAC diretto oppure DASH FLAC compatibile con Myspoti. |
| **Qobuz** | Ricerca nel catalogo e richiesta FLAC in qualità CD. Il file diretto deve iniziare con l'intestazione FLAC. |
| **Deezer** | **Sperimentale e parziale:** accetta solo risposte dichiarate non cifrate e verificabili come FLAC diretto. |
| **Amazon Music** | **Sperimentale e parziale:** accetta solo FLAC diretti non cifrati, con intestazione FLAC verificabile. |

L'API delle estensioni Myspoti non offre il trattamento di stream Deezer cifrati o la decifratura/riconversione dei contenitori Amazon richieste da molte risposte. In questi casi Deezer o Amazon vengono **saltati**: potrebbero non fornire alcun brano compatibile. Non vengono dichiarati funzionanti solo perché la verifica si apre. I server possono cambiare o non essere disponibili.

La sorgente preferita è tentata per prima; seguono le altre attivate, entro i tempi consentiti da Myspoti. Per l'audio il passaggio alla successiva avviene durante la ricerca, prima che il player riceva un indirizzo: non è garantito se un URL già restituito fallisce dopo l'avvio. Per i download, quando possibile, l'estensione restituisce più candidati ordinati e Myspoti prova il successivo se un file non supera i controlli.

Tidal, Qobuz e Deezer confrontano l'ISRC se presente, oppure richiedono una corrispondenza prudente di titolo, artista e durata. Per Amazon, Songlink collega l'ID del brano Spotify all'ASIN della traccia; se la risposta Amazon indica un ISRC diverso, viene scartata. Non tutti i brani esistono su tutte le fonti; qualità, bit e frequenza dipendono dalla risposta reale. Nessun formato con perdita viene convertito in FLAC dall'estensione.

I download sono gestiti da Myspoti, che controlla il file e lo conserva cifrato **dentro l'app**: non sono file FLAC liberamente esportati. Per la prova della riproduzione, disattiva il risparmio dati di Myspoti; i brani già scaricati possono essere letti dal download anziché dalla fonte online.

## Privacy

All'avvio, quando occorre una verifica o un rinnovo, l'estensione può contattare `api.zarz.moe` con un identificatore anonimo dell'installazione e la versione della fonte, anche prima della riproduzione. La ricerca invia a `tidal.com`, `www.qobuz.com` o `api.deezer.com` l'ISRC oppure titolo e artista. Se usi Amazon, `song.link` riceve l'ID Spotify della traccia per trovare la corrispondenza. `api.zarz.moe` riceve l'ID della traccia selezionata e i dati della sessione verificata; i server e le reti di consegna ricevono l'indirizzo IP. Le URL dei file possono essere temporanee e non vengono scritte dall'estensione nei log. Le sessioni sono conservate nello spazio dell'estensione; **Cancella tutte le sessioni** le rimuove dal dispositivo. I dati della WebView sono gestiti da Myspoti.

## Test e limiti

La sequenza automatica, i callback, gli hook, il rinnovo periodico e all’avvio, il tentativo forzato esplicito, i pulsanti manuali per ogni fonte, i controlli di sola lettura e la pausa dopo 429 e le modifiche per Qobuz e Tidal sono stati testati nel runtime ufficiale Myspoti 2.1 con sessioni, ticket e file **simulati**. In controlli precedenti sono stati raggiunti pubblicamente i bootstrap, le pagine di verifica e le ricerche dei cataloghi; il rinnovo di questa versione non è stato provato con una sessione reale né contro un limite reale del server. **Non sono stati provati il completamento umano della verifica, una sessione reale con ticket/media né riproduzione o download su Android.** I test non garantiscono che una fonte funzioni sul telefono.

Se qualcosa non parte, controlla il log dell'estensione e condividi soltanto messaggi ripuliti: niente URL, token, password, codici di verifica, ticket o dati personali.

## Riferimenti e licenze

Riferimenti tecnici: [Mornye Extension Store](https://github.com/mornyeapp/Mornye-Extension), [Mornye Mobile](https://github.com/mornyeapp/Mornye) e [Myspoti](https://github.com/kota-zo/myspoti). Mornye Extension e Mornye Mobile: Copyright 2026 zarzet, GNU LGPL 3.0-only. Questo adattatore indipendente è distribuito con GNU GPL v3; il suo codice è nel pacchetto. `LICENSE` contiene la GPL v3 e `LICENSE.txt` contiene i termini LGPL v3 dei progetti di riferimento.
