const BOOKS = [
["Genesis",50,"old"],["Exodus",40,"old"],["Leviticus",27,"old"],["Numbers",36,"old"],["Deuteronomy",34,"old"],["Joshua",24,"old"],["Judges",21,"old"],["Ruth",4,"old"],["1 Samuel",31,"old"],["2 Samuel",24,"old"],["1 Kings",22,"old"],["2 Kings",25,"old"],["1 Chronicles",29,"old"],["2 Chronicles",36,"old"],["Ezra",10,"old"],["Nehemiah",13,"old"],["Esther",10,"old"],["Job",42,"old"],["Psalms",150,"old"],["Proverbs",31,"old"],["Ecclesiastes",12,"old"],["Song of Solomon",8,"old"],["Isaiah",66,"old"],["Jeremiah",52,"old"],["Lamentations",5,"old"],["Ezekiel",48,"old"],["Daniel",12,"old"],["Hosea",14,"old"],["Joel",3,"old"],["Amos",9,"old"],["Obadiah",1,"old"],["Jonah",4,"old"],["Micah",7,"old"],["Nahum",3,"old"],["Habakkuk",3,"old"],["Zephaniah",3,"old"],["Haggai",2,"old"],["Zechariah",14,"old"],["Malachi",4,"old"],
["Matthew",28,"new"],["Mark",16,"new"],["Luke",24,"new"],["John",21,"new"],["Acts",28,"new"],["Romans",16,"new"],["1 Corinthians",16,"new"],["2 Corinthians",13,"new"],["Galatians",6,"new"],["Ephesians",6,"new"],["Philippians",4,"new"],["Colossians",4,"new"],["1 Thessalonians",5,"new"],["2 Thessalonians",3,"new"],["1 Timothy",6,"new"],["2 Timothy",4,"new"],["Titus",3,"new"],["Philemon",1,"new"],["Hebrews",13,"new"],["James",5,"new"],["1 Peter",5,"new"],["2 Peter",3,"new"],["1 John",5,"new"],["2 John",1,"new"],["3 John",1,"new"],["Jude",1,"new"],["Revelation",22,"new"]
].map(([name, chapters, testament]) => ({name, chapters, testament}));

const el = id => document.getElementById(id);
const ui = {
  testament: el("testament-select"), book: el("book-select"), chapter: el("chapter-select"),
  translation: el("translation-select"), form: el("reference-form"), input: el("reference-input"),
  title: el("passage-title"), testamentLabel: el("testament-label"), translationLabel: el("translation-label"),
  status: el("status-message"), verses: el("verse-list"), previous: el("previous-chapter"),
  next: el("next-chapter"), position: el("chapter-position"), fullChapter: el("full-chapter-button"),
  verse: el("verse-select"), panel: document.querySelector(".reading-panel"),
  meaning: el("meaning-card"), listen: el("listen-button"), listenRate: el("listen-rate"),
  notesToggle: el("notes-toggle"), notepad: el("notepad"), notepadText: el("notepad-text"),
  notepadClose: el("notepad-close"), notepadCount: el("notepad-count"),
  notepadDownload: el("notepad-download"), notepadClear: el("notepad-clear"),
  notepadDate: el("notepad-date")
};
let currentBook = BOOKS[0], currentChapter = 1, currentVerses = [], displayMode = "chapter";

function normalise(value) { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function findBook(name) {
  const wanted = normalise(name);
  const aliases = {psalm:"psalms",songofsongs:"songofsolomon"};
  return BOOKS.find(book => normalise(book.name) === (aliases[wanted] || wanted)) || null;
}
function parseReference(query) {
  // A reference needs a chapter number. A bare book name is not one: "Mark"
  // searches for the word, while "Mark 1" and "Mark 1:2" open the passage.
  const match = query.trim().match(/^(.+?)\s+(\d+)(?:\s*:\s*(\d+)(?:\s*[-–]\s*(\d+))?)?$/);
  if (!match) return null;
  const book = findBook(match[1]);
  if (!book) return null;
  return {
    book: book.name,
    chapter: Number(match[2]),
    verse: match[3] ? Number(match[3]) : null,
  };
}
function looksLikeReference(query) {
  return parseReference(query) !== null;
}
function setStatus(message, error) {
  ui.status.textContent = message || "";
  ui.status.className = error ? "status-message error" : "status-message";
}
function setBusy(busy) {
  ui.panel.setAttribute("aria-busy", String(busy));
  ui.previous.disabled = busy || currentChapter <= 1;
  ui.next.disabled = busy || currentChapter >= currentBook.chapters;
}
function updateLabels() {
  ui.testamentLabel.textContent = currentBook.testament === "old" ? "OLD TESTAMENT" : "NEW TESTAMENT";
  ui.translationLabel.textContent = ui.translation.value === "kjv" ? "KING JAMES VERSION" : "WORLD ENGLISH BIBLE";
  ui.position.textContent = "Chapter " + currentChapter + " of " + currentBook.chapters;
}
function populateBooks(preferredName) {
  const filtered = BOOKS.filter(book => ui.testament.value === "all" || book.testament === ui.testament.value);
  ui.book.replaceChildren();
  filtered.forEach(book => {
    const option = document.createElement("option");
    option.value = book.name; option.textContent = book.name; ui.book.append(option);
  });
  currentBook = filtered.find(book => book.name === preferredName) || filtered[0];
  ui.book.value = currentBook.name;
  populateChapters(currentChapter);
}
function populateChapters(preferredChapter) {
  currentChapter = Math.min(Math.max(Number(preferredChapter) || 1, 1), currentBook.chapters);
  ui.chapter.replaceChildren();
  for (let number = 1; number <= currentBook.chapters; number += 1) {
    const option = document.createElement("option");
    option.value = String(number); option.textContent = "Chapter " + number; ui.chapter.append(option);
  }
  ui.chapter.value = String(currentChapter);
}
function populateVerses(count) {
  ui.verse.replaceChildren();
  const all = document.createElement("option");
  all.value = "all"; all.textContent = "All verses"; ui.verse.append(all);
  for (let number = 1; number <= count; number += 1) {
    const option = document.createElement("option");
    option.value = String(number); option.textContent = "Verse " + number; ui.verse.append(option);
  }
  ui.verse.value = "all";
}
function updateTitle(title) {
  ui.title.replaceChildren(document.createTextNode(title || (currentBook.name + " " + currentChapter)));
}
async function fetchPassage(reference) {
  const query = new URLSearchParams({reference, translation:ui.translation.value});
  const response = await fetch("/api/passage?" + query.toString());
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Could not load that passage.");
    error.status = response.status;
    throw error;
  }
  if (!Array.isArray(data.verses) || data.verses.length === 0) throw new Error("No verses were returned for that passage.");
  return data;
}
function appendHighlighted(parent, text, needle) {
  const needles = (Array.isArray(needle) ? needle : [needle]).filter(Boolean);
  if (!needles.length) { parent.append(document.createTextNode(text)); return; }
  const lowered = text.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    let best = -1, bestLength = 0;
    needles.forEach(word => {
      const at = lowered.indexOf(word.toLowerCase(), cursor);
      if (at === -1) return;
      if (best === -1 || at < best || (at === best && word.length > bestLength)) {
        best = at; bestLength = word.length;
      }
    });
    if (best === -1) { parent.append(document.createTextNode(text.slice(cursor))); break; }
    if (best > cursor) parent.append(document.createTextNode(text.slice(cursor, best)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(best, best + bestLength);
    parent.append(mark);
    cursor = best + bestLength;
  }
}
function renderVerses(verses, term) {
  ui.verses.replaceChildren();
  if (!verses.length) {
    const message = document.createElement("p");
    message.className = "empty-results";
    message.textContent = "No matching verses found in " + currentBook.name + " " + currentChapter + ". Try another word or a passage reference.";
    ui.verses.append(message);
    return;
  }
  const needle = (term || "").toLowerCase();
  verses.forEach(verse => {
    const paragraph = document.createElement("p");
    paragraph.className = "verse";
    const number = document.createElement("sup");
    paragraph.id = "verse-" + verse.verse;
    number.className = "verse-number"; number.textContent = verse.verse;
    paragraph.append(number, document.createTextNode(" "));
    appendHighlighted(paragraph, verse.text.trim(), needle);
    ui.verses.append(paragraph);
  });
}
async function loadChapter(book, chapter) {
  currentBook = book || currentBook;
  currentChapter = chapter || currentChapter;
  populateChapters(currentChapter);
  displayMode = "chapter";
  ui.fullChapter.hidden = true;
  stopSpeech();
  hideMeaning();
  updateTitle();
  updateLabels();
  setBusy(true);
  setStatus("Loading " + currentBook.name + " " + currentChapter + "…");
  try {
    const data = await fetchPassage(currentBook.name + " " + currentChapter);
    currentVerses = data.verses;
    renderVerses(currentVerses, "");
    populateVerses(currentVerses.length);
    setStatus("");
    ui.input.value = "";
  } catch (error) {
    currentVerses = [];
    ui.verses.replaceChildren();
    setStatus(error.message + " Check your connection and try again.", true);
  } finally {
    setBusy(false);
    updateLabels();
  }
}
async function loadVerse(number) {
  // Choosing a verse should show that verse, not leave the whole chapter up.
  displayMode = "verse";
  stopSpeech();
  hideMeaning();
  const label = currentBook.name + " " + currentChapter + ":" + number;
  updateTitle(label);
  updateLabels();
  setBusy(true);
  setStatus("Loading " + label + "…");
  try {
    const data = await fetchPassage(label);
    currentVerses = data.verses;
    renderVerses(currentVerses, "");
    ui.fullChapter.hidden = false;
    setStatus("");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
    updateLabels();
  }
}
async function searchReference(reference) {
  // A chapter beyond the end of the book is not something to search for, and an
  // empty result set would look broken. Say how many chapters exist instead.
  const parsed = parseReference(reference);
  if (parsed) {
    const book = findBook(parsed.book);
    if (book && parsed.chapter > book.chapters) {
      setStatus(book.name + " has " + book.chapters + " chapters, so chapter " + parsed.chapter + " does not exist.", true);
      return;
    }
  }
  stopSpeech();
  hideMeaning();
  setBusy(true);
  setStatus("Looking up " + reference + "…");
  ui.verses.replaceChildren();
  let searchInstead = false;
  let searchNote = "";
  try {
    const data = await fetchPassage(reference);
    const book = findBook(data.verses[0].book_name || "");
    const chapter = Number(data.verses[0].chapter) || 1;
    if (book) {
      currentBook = book; currentChapter = chapter;
      ui.testament.value = book.testament;
      populateBooks(book.name); populateChapters(chapter);
    }
    currentVerses = data.verses;
    populateVerses(parsed && parsed.verse ? 0 : currentVerses.length);
    displayMode = "passage";
    renderVerses(currentVerses, "");
    updateTitle(data.reference || reference);
    updateLabels();
    ui.fullChapter.hidden = false;
    ui.input.value = reference;
    setStatus("");
  } catch (error) {
    // Never dead-end. Whatever went wrong, search what the reader typed, so the
    // page always answers with verses instead of an error they cannot act on.
    searchInstead = true;
    if (error.status !== 400 && error.status !== 404) {
      searchNote = error.message + " Showing search results instead.";
    }
  } finally {
    setBusy(false);
    updateLabels();
  }
  if (searchInstead) await searchKeyword(reference, searchNote);
}
function renderSearchResults(data, term) {
  ui.verses.replaceChildren();
  if (!data.results.length) {
    const message = document.createElement("p");
    message.className = "empty-results";
    message.textContent = "No verse in the Bible contains “" + term + "”. Try a different word or a passage reference.";
    ui.verses.append(message);
    return;
  }
  const needles = data.approximate ? (data.matched_words || []) : [term.toLowerCase()];
  data.results.forEach(result => {
    const item = document.createElement("p");
    item.className = "verse search-result";
    const link = document.createElement("button");
    link.type = "button";
    link.className = "result-reference";
    link.textContent = result.reference;
    link.addEventListener("click", () => {
      ui.input.value = result.reference;
      searchReference(result.reference);
    });
    item.append(link, document.createTextNode(" "));
    appendHighlighted(item, result.text, needles);
    ui.verses.append(item);
  });
}
async function searchKeyword(term, note) {
  const needle = term.trim();
  if (!needle) { setStatus("Enter a passage reference or keyword.", true); return; }
  displayMode = "keyword";
  ui.fullChapter.hidden = true;
  stopSpeech();
  hideMeaning();
  updateTitle("Search: “" + needle + "”");
  ui.verses.replaceChildren();
  setBusy(true);
  setStatus("Searching the Bible for “" + needle + "”…");
  try {
    const response = await fetch("/api/search?q=" + encodeURIComponent(needle));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not search just now.");
    renderSearchResults(data, needle);
    showMeaning(needle);
    const noun = data.total === 1 ? "verse" : "verses";
    const more = data.shown < data.total ? " Showing the first " + data.shown + "." : "";
    const lead = note ? note + " " : "";
    if (data.approximate) {
      const words = (data.matched_words || []).join(", ");
      setStatus(lead + "No verse contains “" + needle + "” exactly. Closest verses, matched on " + words + "." + more + " Results use the King James Version.");
    } else {
      setStatus(lead + data.total + " " + noun + " in the Bible contain “" + needle + "”." + more + " Results use the King James Version.");
    }
  } catch (error) {
    setStatus(error.message + " Check your connection and try again.", true);
  } finally {
    setBusy(false);
  }
}
ui.testament.addEventListener("change", () => { populateBooks(currentBook.name); loadChapter(currentBook,1); });
ui.book.addEventListener("change", () => {
  const selected = findBook(ui.book.value);
  if (selected) { currentBook = selected; populateChapters(1); loadChapter(currentBook,1); }
});
ui.chapter.addEventListener("change", () => loadChapter(currentBook,Number(ui.chapter.value)));
ui.verse.addEventListener("change", () => {
  if (ui.verse.value === "all") { loadChapter(currentBook, currentChapter); return; }
  loadVerse(Number(ui.verse.value));
});
ui.translation.addEventListener("change", () => {
  if (displayMode === "passage" && ui.input.value.trim()) searchReference(ui.input.value.trim());
  else loadChapter(currentBook,currentChapter);
});
ui.form.addEventListener("submit", event => {
  event.preventDefault();
  const query = ui.input.value.trim();
  if (!query) { setStatus("Enter a passage reference or keyword.",true); return; }
  if (looksLikeReference(query)) searchReference(query);
  else searchKeyword(query);
});
document.querySelector(".example-reference").addEventListener("click", () => {
  ui.input.value = "John 3:16"; searchReference("John 3:16");
});
document.querySelectorAll(".quick-link").forEach(button => button.addEventListener("click", () => {
  const book = findBook(button.dataset.book), chapter = Number(button.dataset.chapter) || 1;
  if (!book) return;
  currentBook = book; currentChapter = chapter; ui.testament.value = book.testament;
  populateBooks(book.name); populateChapters(chapter);
  if (button.dataset.verse) { const reference = book.name + " " + chapter + ":" + button.dataset.verse; ui.input.value = reference; searchReference(reference); }
  else loadChapter(book,chapter);
}));
ui.previous.addEventListener("click", () => { if (currentChapter > 1) loadChapter(currentBook,currentChapter - 1); });
ui.next.addEventListener("click", () => { if (currentChapter < currentBook.chapters) loadChapter(currentBook,currentChapter + 1); });
ui.fullChapter.addEventListener("click", () => loadChapter(currentBook,currentChapter));

/* ---------------- The meaning of a name or an unfamiliar word ---------------- */

function hideMeaning() {
  if (!ui.meaning) return;
  ui.meaning.hidden = true;
  ui.meaning.replaceChildren();
}

function renderMeaning(data) {
  const card = ui.meaning;
  card.replaceChildren();

  const topline = document.createElement("div");
  topline.className = "meaning-topline";
  const kind = document.createElement("span");
  kind.className = "meaning-kind";
  kind.textContent = "Meaning";
  const term = document.createElement("h3");
  term.className = "meaning-term";
  term.textContent = data.matched_term || data.term;
  topline.append(kind, term);
  card.append(topline);

  const body = document.createElement("div");
  body.className = "meaning-body";
  (data.meanings || []).forEach(meaning => {
    const paragraph = document.createElement("p");
    paragraph.textContent = meaning.text;
    const source = document.createElement("span");
    source.className = "meaning-source";
    source.textContent = meaning.source;
    paragraph.append(source);
    body.append(paragraph);
  });
  card.append(body);

  if (data.references && data.references.length) {
    const refs = document.createElement("div");
    refs.className = "meaning-refs";
    data.references.forEach(result => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "meaning-ref";
      button.textContent = result.reference;
      button.addEventListener("click", () => {
        ui.input.value = result.reference;
        searchReference(result.reference);
      });
      refs.append(button);
    });
    card.append(refs);
  }

  const note = document.createElement("p");
  note.className = "meaning-note";
  const count = data.total || 0;
  note.textContent = count
    ? count + (count === 1 ? " verse" : " verses") + " in the King James Bible use this word."
    : "This word does not appear in the King James text itself.";
  card.append(note);

  card.hidden = false;
}

async function showMeaning(term) {
  if (!ui.meaning) return;
  const needle = (term || "").trim();
  if (needle.length < 2) { hideMeaning(); return; }
  try {
    const response = await fetch("/api/define?term=" + encodeURIComponent(needle));
    if (!response.ok) { hideMeaning(); return; }
    const data = await response.json();
    if (!data.found) { hideMeaning(); return; }
    renderMeaning(data);
  } catch (error) {
    hideMeaning();
  }
}

/* ---------------- Listen: the app reads the passage aloud ---------------- */

const speech = {
  synth: "speechSynthesis" in window ? window.speechSynthesis : null,
  state: "idle",
  index: 0,
  rate: 1
};
let speechGeneration = 0;

function clearSpeakingHighlight() {
  document.querySelectorAll(".verse-speaking").forEach(node => node.classList.remove("verse-speaking"));
}

function updateListenButton() {
  if (!ui.listen) return;
  if (!speech.synth) {
    // No voice available: hide the control rather than offer a dead button.
    ui.listen.hidden = true;
    if (ui.listenRate) ui.listenRate.hidden = true;
    return;
  }
  const labels = { idle: "Listen ▸", speaking: "Pause ❙❙", paused: "Resume ▸" };
  ui.listen.textContent = labels[speech.state] || labels.idle;
  ui.listen.setAttribute("aria-pressed", speech.state === "speaking" ? "true" : "false");
}

function stopSpeech() {
  speechGeneration += 1;
  if (speech.synth) speech.synth.cancel();
  speech.state = "idle";
  speech.index = 0;
  clearSpeakingHighlight();
  updateListenButton();
}

function speakVerse(index) {
  if (!speech.synth) return;
  const verses = currentVerses;
  if (!verses.length || index >= verses.length) { stopSpeech(); return; }
  const verse = verses[index];
  const generation = speechGeneration;
  speech.index = index;

  clearSpeakingHighlight();
  const node = document.getElementById("verse-" + verse.verse);
  if (node) {
    node.classList.add("verse-speaking");
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const utterance = new SpeechSynthesisUtterance(verse.verse + ". " + verse.text.trim());
  utterance.rate = speech.rate;
  utterance.lang = "en-US";
  utterance.onend = () => {
    if (generation !== speechGeneration) return;
    if (speech.state === "speaking") speakVerse(index + 1);
  };
  utterance.onerror = () => {
    if (generation !== speechGeneration) return;
    if (speech.state === "speaking") stopSpeech();
  };
  speech.synth.speak(utterance);
}

function restartSpeechFrom(index) {
  speechGeneration += 1;
  if (speech.synth) speech.synth.cancel();
  speech.state = "speaking";
  speakVerse(index);
}

function toggleSpeech() {
  if (!speech.synth) {
    setStatus("This browser cannot read aloud. Try Chrome, Edge, or Safari.", true);
    return;
  }
  if (speech.state === "speaking") {
    speech.synth.pause();
    speech.state = "paused";
  } else if (speech.state === "paused") {
    speech.synth.resume();
    speech.state = "speaking";
  } else {
    if (!currentVerses.length) { setStatus("Open a passage first, then press Listen.", true); return; }
    speechGeneration += 1;
    speech.state = "speaking";
    speakVerse(0);
  }
  updateListenButton();
}

/* ---------------- Notepad ---------------- */

const NOTES_KEY = "stillword.notes.v1";
let notesTimer = null;

function updateNotesCount() {
  if (!ui.notepadCount || !ui.notepadText) return;
  const trimmed = ui.notepadText.value.trim();
  const count = trimmed ? trimmed.split(/\s+/).length : 0;
  ui.notepadCount.textContent = count + (count === 1 ? " word" : " words");
}

function saveNotes() {
  if (!ui.notepadText) return;
  try {
    window.localStorage.setItem(NOTES_KEY, ui.notepadText.value);
  } catch (error) {
    // Private browsing can refuse storage; the notes still work for this visit.
  }
}

function loadNotes() {
  if (!ui.notepadText) return;
  try {
    const stored = window.localStorage.getItem(NOTES_KEY);
    if (stored) ui.notepadText.value = stored;
  } catch (error) {
    // Nothing saved yet, or storage is unavailable.
  }
  updateNotesCount();
}

function setNotesOpen(open) {
  if (!ui.notepad) return;
  ui.notepad.classList.toggle("open", open);
  ui.notepad.setAttribute("aria-hidden", open ? "false" : "true");
  if (ui.notesToggle) ui.notesToggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) return;
  if (ui.notepadDate) {
    ui.notepadDate.textContent = new Date().toLocaleDateString(undefined, {
      weekday: "long", day: "numeric", month: "long"
    });
  }
  loadNotes();
  window.setTimeout(() => { if (ui.notepadText) ui.notepadText.focus(); }, 320);
}

function downloadNotes() {
  if (!ui.notepadText) return;
  const blob = new Blob([ui.notepadText.value || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "stillword-notes-" + new Date().toISOString().slice(0, 10) + ".txt";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if (ui.listen) ui.listen.addEventListener("click", toggleSpeech);
if (ui.listenRate) ui.listenRate.addEventListener("change", () => {
  speech.rate = Number(ui.listenRate.value) || 1;
  if (speech.state === "speaking" || speech.state === "paused") restartSpeechFrom(speech.index);
});
if (ui.notesToggle) ui.notesToggle.addEventListener("click", () => {
  setNotesOpen(!ui.notepad.classList.contains("open"));
});
if (ui.notepadClose) ui.notepadClose.addEventListener("click", () => setNotesOpen(false));
if (ui.notepadText) ui.notepadText.addEventListener("input", () => {
  updateNotesCount();
  window.clearTimeout(notesTimer);
  notesTimer = window.setTimeout(saveNotes, 400);
});
if (ui.notepadDownload) ui.notepadDownload.addEventListener("click", downloadNotes);
if (ui.notepadClear) ui.notepadClear.addEventListener("click", () => {
  const empty = !ui.notepadText.value.trim();
  if (!empty && !window.confirm("Clear all your notes? This cannot be undone.")) return;
  ui.notepadText.value = "";
  updateNotesCount();
  saveNotes();
  ui.notepadText.focus();
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  // Escape backs out of whatever the reader opened: the notepad, or the voice.
  if (ui.notepad && ui.notepad.classList.contains("open")) setNotesOpen(false);
  if (speech.state !== "idle") stopSpeech();
});
loadNotes();
updateListenButton();

populateBooks("Genesis"); populateChapters(1); loadChapter(currentBook,1);
