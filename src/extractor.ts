import { ContentType } from "stremio-addon-sdk";
import * as cheerio from "cheerio";

// --- Configuration for VixCloud ---
const VIXCLOUD_SITE_ORIGIN = "https://vixsrc.to"; // e.g., "https://vixcloud.co"
const VIXCLOUD_REQUEST_TITLE_PATH = "/richiedi-un-titolo"; // Path used to fetch site version
const VIXCLOUD_EMBED_BASE_PATH = "/embed"; // Base path for embed URLs, e.g., /embed/movie/tt12345
// --- TMDB Configuration ---
const TMDB_API_KEY = process.env.TMDB_API_KEY; 
const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";
// --- Proxy Configuration ---
const MFP_URL = process.env.MFP_URL; // Proxy URL
const MFP_PSW = process.env.MFP_PSW; // Proxy Password
console.log("MFP_URL from env:", MFP_URL);
console.log("MFP_PSW from env:", MFP_PSW);

// --- End Configuration ---

export interface VixCloudStreamInfo {
  name: string;
  streamUrl: string;
  referer: string;
  source: 'proxy' | 'direct';
}

/**
 * Fetches the site version from VixCloud.
 * This is analogous to the `version` method in the Python VixCloudExtractor.
 */
async function fetchVixCloudSiteVersion(siteOrigin: string): Promise<string> {
  const versionUrl = `${siteOrigin}${VIXCLOUD_REQUEST_TITLE_PATH}`;
  try {
    const response = await fetch(versionUrl, {
      headers: {
        "Referer": `${siteOrigin}/`,
        "Origin": siteOrigin,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch version, status: ${response.status}`);
    }
    const html = await response.text();
    const $ = cheerio.load(html);
    const appDiv = $("div#app");
    if (appDiv.length > 0) {
      const dataPage = appDiv.attr("data-page");
      if (dataPage) {
        const jsonData = JSON.parse(dataPage);
        if (jsonData && jsonData.version) {
          return jsonData.version;
        }
      }
    }
    throw new Error("Failed to parse version from page data.");
  } catch (error) {
    let message = "Unknown error";
    if (error instanceof Error) {
      message = error.message;
    }
    console.error("Error fetching VixCloud site version:", message, error); // Logga il messaggio e l'errore originale
    throw new Error(`Failed to get VixCloud site version: ${message}`);
  }
}

function getObject(id: string) {
  const arr = id.split(':');
  return {
    id: arr[0],
    season: arr[1],
    episode: arr[2]
  };
}

async function getTmdbIdFromImdbId(imdbId: string): Promise<string | null> {
  if (!TMDB_API_KEY) { 
    console.error("TMDB_API_KEY is not configured.");
    return null;
  }
  const findUrl = `${TMDB_API_BASE_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
  try {
    const response = await fetch(findUrl);
    if (!response.ok) {
      console.error(`Failed to fetch TMDB ID for ${imdbId}: ${response.status}`);
      return null;
    }
    const data = await response.json();
    if (data.movie_results && data.movie_results.length > 0) {
      return data.movie_results[0].id.toString();
    } else if (data.tv_results && data.tv_results.length > 0) { 
      return data.tv_results[0].id.toString();
    }
    console.warn(`No TMDB movie or TV results found for IMDb ID: ${imdbId}`);
    return null;
  } catch (error) {
    console.error(`Error fetching TMDB ID for ${imdbId}:`, error);
    return null;
  }
}

// 1. Aggiungi la funzione di verifica dei TMDB ID
async function checkTmdbIdOnVixSrc(tmdbId: string, type: ContentType): Promise<boolean> {
  const vixSrcApiType = type === 'movie' ? 'movie' : 'tv'; // VixSrc usa 'tv' per le serie
  const listUrl = `${VIXCLOUD_SITE_ORIGIN}/api/list/${vixSrcApiType}?lang=it`;

  try {
    console.log(`VIX_CHECK: Checking TMDB ID ${tmdbId} of type ${vixSrcApiType} against VixSrc list: ${listUrl}`);
    const response = await fetch(listUrl);
    if (!response.ok) {
      console.error(`VIX_CHECK: Failed to fetch VixSrc list for type ${vixSrcApiType}, status: ${response.status}`);
      return false; // Se non possiamo ottenere la lista, assumiamo che non esista per sicurezza
    }
    const data = await response.json();
    // L'API restituisce un array di oggetti, ognuno con una proprietà 'id' che è l'ID TMDB
    if (data && Array.isArray(data)) {
      const exists = data.some((item: any) => item.tmdb_id && item.tmdb_id.toString() === tmdbId.toString());
      console.log(`VIX_CHECK: TMDB ID ${tmdbId} ${exists ? 'found' : 'NOT found'} in VixSrc list.`);
      return exists;
    } else {
      console.error(`VIX_CHECK: VixSrc list for type ${vixSrcApiType} is not in the expected format.`);
      return false;
    }
  } catch (error) {
    console.error(`VIX_CHECK: Error checking TMDB ID ${tmdbId} on VixSrc:`, error);
    return false; // In caso di errore, assumiamo che non esista
  }
}

// 2. Modifica la funzione getUrl per rimuovere ?lang=it e aggiungere la verifica
export async function getUrl(id: string, type: ContentType): Promise<string | null> {
  if (type == "movie") {
    const imdbIdForMovie = id; // L'ID passato è l'IMDB ID per i film
    const tmdbId = await getTmdbIdFromImdbId(imdbIdForMovie);
    if (!tmdbId) return null;
    
    // Verifica se l'ID TMDB del film esiste su VixSrc
    const existsOnVixSrc = await checkTmdbIdOnVixSrc(tmdbId, type);
    if (!existsOnVixSrc) {
      console.log(`TMDB ID ${tmdbId} (from IMDB ${imdbIdForMovie}) for movie not found in VixSrc list. Skipping.`);
      return null;
    }
    
    return `${VIXCLOUD_SITE_ORIGIN}/movie/${tmdbId}/`; // Rimosso ?lang=it
  } else {
    // Series: https://vixsrc.to/tv/tmdbkey/season/episode/
    const obj = getObject(id);
    const tmdbSeriesId = await getTmdbIdFromImdbId(obj.id);
    if (!tmdbSeriesId) return null;
    
    // Verifica se l'ID TMDB della serie esiste su VixSrc
    const existsOnVixSrc = await checkTmdbIdOnVixSrc(tmdbSeriesId, type);
    if (!existsOnVixSrc) {
      console.log(`TMDB ID ${tmdbSeriesId} (from IMDB ${obj.id}) for series not found in VixSrc list. Skipping.`);
      return null;
    }
    
    return `${VIXCLOUD_SITE_ORIGIN}/tv/${tmdbSeriesId}/${obj.season}/${obj.episode}/`; // Rimosso ?lang=it
  }
}

async function getStreamContent(id: string, type: ContentType): Promise<VixCloudStreamInfo[] | null> {
  console.log(`Extracting stream for ${id} (${type})`);
  
  // First, get the target URL on vixsrc.to (this is needed for both proxy and direct modes)
  const targetUrl = await getUrl(id, type);
  if (!targetUrl) {
    console.error(`Could not generate target URL for ${id} (${type})`);
    return null;
  }

  // Helper function to fetch movie title from TMDB
  async function getMovieTitle(imdbId: string): Promise<string | null> {
    const tmdbId = await getTmdbIdFromImdbId(imdbId);
    if (!tmdbId) return null;
    const movieDetailsUrl = `${TMDB_API_BASE_URL}/movie/${tmdbId}?api_key=${TMDB_API_KEY}&language=it`;
    try {
      const response = await fetch(movieDetailsUrl);
      if (!response.ok) {
        console.error(`Error fetching movie title for TMDB ID ${tmdbId}: ${response.status}`);
        return null;
      }
      const data = await response.json();
      return data.title || null;
    } catch (error) {
      console.error("Error fetching movie title:", error);
      return null;
    }
  }

  // Helper function to fetch series title from TMDB
  async function getSeriesTitle(imdbId: string): Promise<string | null> {
    const tmdbId = await getTmdbIdFromImdbId(imdbId.split(':')[0]); // Use base IMDB ID for series
    if (!tmdbId) return null;
    const seriesDetailsUrl = `${TMDB_API_BASE_URL}/tv/${tmdbId}?api_key=${TMDB_API_KEY}&language=it`;
    try {
      const response = await fetch(seriesDetailsUrl);
      if (!response.ok) {
        console.error(`Error fetching series title for TMDB ID ${tmdbId}: ${response.status}`);
        return null;
      }
      const data = await response.json();
      return data.name || null;
    } catch (error) {
      console.error("Error fetching series title:", error);
      return null;
    }
  }

  // --- Check if Proxy is Configured ---
  if (MFP_URL && MFP_PSW) {
    // --- Proxy Mode ---
    const proxyStreamUrl = `${MFP_URL}/extractor/video?host=VixCloud&redirect_stream=true&api_password=${MFP_PSW}&d=${encodeURIComponent(targetUrl)}`;
    console.log(`Proxy mode active. Generated proxy URL for ${id}: ${proxyStreamUrl}`);

    // Nuova funzione asincrona per ottenere l'URL m3u8 finale
    async function getActualStreamUrl(proxyUrl: string): Promise<string> {
      try {
        // In modalità "debug" non seguiamo i reindirizzamenti e otteniamo l'URL m3u8 dalla risposta JSON
        const debugUrl = proxyUrl.replace('redirect_stream=true', 'redirect_stream=false');
        
        console.log(`Fetching stream URL from: ${debugUrl}`);
        const response = await fetch(debugUrl);
        
        if (!response.ok) {
          console.error(`Failed to fetch stream details: ${response.status}`);
          return proxyUrl; // Fallback al proxy URL originale
        }
        
        const data = await response.json();
        console.log(`MFP Response:`, data);
        
        // CORREZIONE: usa mediaflow_proxy_url invece di stream_url
        if (data && data.mediaflow_proxy_url) {
          // Costruisci l'URL completo includendo i parametri necessari
          let finalUrl = data.mediaflow_proxy_url;
          
          // Aggiungi i parametri di query se presenti
          if (data.query_params) {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(data.query_params)) {
              params.append(key, value as string);
            }
            
            // Se l'URL ha già parametri, aggiungi & altrimenti ?
            finalUrl += (finalUrl.includes('?') ? '&' : '?') + params.toString();
          }
          
          // Aggiungi il parametro d per il destination_url
          if (data.destination_url) {
            const destParam = 'd=' + encodeURIComponent(data.destination_url);
            finalUrl += (finalUrl.includes('?') ? '&' : '?') + destParam;
          }
          
          // Aggiungi gli header come parametri h_
          if (data.request_headers) {
            for (const [key, value] of Object.entries(data.request_headers)) {
              const headerParam = `h_${key}=${encodeURIComponent(value as string)}`;
              finalUrl += '&' + headerParam;
            }
          }
          
          console.log(`Extracted proxy m3u8 URL: ${finalUrl}`);
          return finalUrl;
        } else {
          console.warn(`Couldn't find mediaflow_proxy_url in MFP response, using proxy URL`);
          return proxyUrl; // Fallback al proxy URL originale
        }
      } catch (error) {
        console.error(`Error extracting m3u8 URL: ${error}`);
        return proxyUrl; // Fallback al proxy URL originale
      }
    }

    const tmdbApiTitle: string | null = type === 'movie' ? await getMovieTitle(id) : await getSeriesTitle(id);

    let finalNameForProxy: string;

    if (tmdbApiTitle) { // Titolo TMDB trovato
      finalNameForProxy = tmdbApiTitle;
      if (type !== 'movie') { // È una serie, aggiungi Stagione/Episodio
        const obj = getObject(id);
        finalNameForProxy += ` (S${obj.season}E${obj.episode})`;
      }
    } else { // Titolo TMDB non trovato, usa il fallback
      if (type === 'movie') {
        finalNameForProxy = 'Movie Stream (Proxy)';
      } else { // Serie
        const obj = getObject(id);
        // Per richiesta utente, anche i titoli di fallback delle serie dovrebbero avere S/E
        finalNameForProxy = `Series Stream (Proxy) (S${obj.season}E${obj.episode})`;
      }
    }
    // Ottieni l'URL m3u8 finale
    const finalStreamUrl = await getActualStreamUrl(proxyStreamUrl);
    console.log(`Final m3u8 URL: ${finalStreamUrl}`);
    
    return [{ name: finalNameForProxy, streamUrl: finalStreamUrl, referer: targetUrl, source: 'proxy' }];
  }

  // --- Direct Extraction Mode (if proxy not configured) ---
  const siteOrigin = new URL(targetUrl).origin;
  let pageHtml = "";
  let finalReferer = targetUrl;

  try {
    if (targetUrl.includes("/iframe")) { 
      const version = await fetchVixCloudSiteVersion(siteOrigin);
      const initialResponse = await fetch(targetUrl, {
        headers: { "x-inertia": "true", "x-inertia-version": version, "Referer": `${siteOrigin}/` },
      });
      if (!initialResponse.ok) throw new Error(`Initial iframe request failed: ${initialResponse.status}`);
      const initialHtml = await initialResponse.text();
      const $initial = cheerio.load(initialHtml);
      const iframeSrc = $initial("iframe").attr("src");

      if (iframeSrc) {
        const actualPlayerUrl = new URL(iframeSrc, siteOrigin).toString();
        const playerResponse = await fetch(actualPlayerUrl, {
          headers: { "x-inertia": "true", "x-inertia-version": version, "Referer": targetUrl },
        });
        if (!playerResponse.ok) throw new Error(`Player iframe request failed: ${playerResponse.status}`);
        pageHtml = await playerResponse.text();
        finalReferer = actualPlayerUrl;
      } else {
        throw new Error("Iframe src not found in initial response.");
      }
    } else { 
      const response = await fetch(targetUrl);
      if (!response.ok) throw new Error(`Direct embed request failed: ${response.status}`);
      pageHtml = await response.text();
    }

    const $ = cheerio.load(pageHtml);
    const scriptTag = $("body script").filter((_, el) => {
      const htmlContent = $(el).html();
      return !!htmlContent && htmlContent.includes("'token':") && htmlContent.includes("'expires':");
    }).first();
    const scriptContent = scriptTag.html();

    if (!scriptContent) throw new Error("Player script with token/expires not found.");

    const tokenMatch = scriptContent.match(/'token':\s*'(\w+)'/);
    const expiresMatch = scriptContent.match(/'expires':\s*'(\d+)'/);
    const serverUrlMatch = scriptContent.match(/url:\s*'([^']+)'/);

    if (!tokenMatch || !expiresMatch || !serverUrlMatch) {
      throw new Error("Failed to extract token, expires, or server URL from script.");
    }

    const token = tokenMatch[1];
    const expires = expiresMatch[1];
    let serverUrl = serverUrlMatch[1];

    let finalStreamUrl = serverUrl.includes("?b=1")
      ? `${serverUrl}&token=${token}&expires=${expires}`
      : `${serverUrl}?token=${token}&expires=${expires}`;

    // Aggiungi &h=1 solo se disponibile
    if (scriptContent.includes("window.canPlayFHD = true")) {
      finalStreamUrl += "&h=1";
    } 

    // --- Inizio della nuova logica per il titolo ---

    // 1. Ottieni il titolo di base, dando priorità a TMDB
    let baseTitle: string | null = null;

    // Prima prova a ottenere il titolo dalle API TMDB
    baseTitle = type === 'movie' ? 
      await getMovieTitle(id) : 
      await getSeriesTitle(id);
    
    console.log(`TMDB title result: "${baseTitle}"`);
  
    // Solo se TMDB fallisce, prova a usare il titolo dalla pagina
    if (!baseTitle) {
      baseTitle = $("title").text().trim();
      // Pulisci ulteriormente il titolo rimuovendo parti comuni nei siti di streaming
      if (baseTitle) {
        baseTitle = baseTitle
          .replace(" - VixSrc", "")
          .replace(" - Guarda Online", "")
          .replace(" - Streaming", "")
          .replace(/\s*\|\s*.*$/, ""); // Rimuove qualsiasi cosa dopo il simbolo |
      }
      console.log(`Page title after cleanup: "${baseTitle}"`);
    }

    // 2. Determina il nome finale, gestendo esplicitamente il caso null
    let determinedName: string;
    if (baseTitle) {
      // Se abbiamo un titolo, ora siamo sicuri che sia una stringa.
      if (type === 'movie') {
        determinedName = baseTitle;
      } else { // È una serie, aggiungi info S/E
        const obj = getObject(id);
        determinedName = `${baseTitle} (S${obj.season}E${obj.episode})`;
      }
    } else {
      // Se non abbiamo un titolo (baseTitle è null), usiamo un nome di fallback.
      if (type === 'movie') {
        determinedName = 'Movie Stream (Direct)';
      } else { // È una serie
        const obj = getObject(id);
        // Per richiesta utente, anche i titoli di fallback delle serie dovrebbero avere S/E
        determinedName = `Series Stream (Direct) (S${obj.season}E${obj.episode})`;
      }
    }
    
    console.log(`Final stream name: "${determinedName}"`);
    console.log(`Final stream URL: "${finalStreamUrl}"`); // Aggiungi questo log per l'URL

    return [{
      name: determinedName,
      streamUrl: finalStreamUrl,
      referer: finalReferer,
      source: 'direct'
    }];

  } catch (error) {
    let message = "Unknown error during stream content extraction";
    if (error instanceof Error) {
      message = error.message;
    }
    console.error(`Stream extraction error: ${message}`, error);
    
    // Ritorna null invece di un oggetto con URL HTML
    return null;
  }
}
export { getStreamContent };
