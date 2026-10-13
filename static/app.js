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
  panel: document.querySelector(".reading-panel")
};
let currentBook = BOOKS[0], currentChapter = 1, currentVerses = [], displayMode = "chapter";

function normalise(value) { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function findBook(name) {
  const wanted = normalise(name);
  const aliases = {psalm:"psalms",songofsongs:"songofsolomon"};
  return BOOKS.find(book => normalise(book.name) === (aliases[wanted] || wanted)) || null;
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
function updateTitle(title) {
  ui.title.replaceChildren(document.createTextNode(title || (currentBook.name + " " + currentChapter)));
}
async function fetchPassage(reference) {
  const query = new URLSearchParams({reference, translation:ui.translation.value});
  const response = await fetch("/api/passage?" + query.toString());
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load that passage.");
  if (!Array.isArray(data.verses) || data.verses.length === 0) throw new Error("No verses were returned for that passage.");
  return data;
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
    number.className = "verse-number"; number.textContent = verse.verse;
    paragraph.append(number, document.createTextNode(" "));
    const text = verse.text.trim();
    if (!needle) {
      paragraph.append(document.createTextNode(text));
    } else {
      let cursor = 0, index = text.toLowerCase().indexOf(needle);
      while (index !== -1) {
        paragraph.append(document.createTextNode(text.slice(cursor,index)));
        const mark = document.createElement("mark");
        mark.textContent = text.slice(index,index + needle.length);
        paragraph.append(mark);
        cursor = index + needle.length;
        index = text.toLowerCase().indexOf(needle,cursor);
      }
      paragraph.append(document.createTextNode(text.slice(cursor)));
    }
    ui.verses.append(paragraph);
  });
}
async function loadChapter(book, chapter) {
  currentBook = book || currentBook;
  currentChapter = chapter || currentChapter;
  populateChapters(currentChapter);
  displayMode = "chapter";
  ui.fullChapter.hidden = true;
  updateTitle();
  updateLabels();
  setBusy(true);
  setStatus("Loading " + currentBook.name + " " + currentChapter + "…");
  try {
    const data = await fetchPassage(currentBook.name + " " + currentChapter);
    currentVerses = data.verses;
    renderVerses(currentVerses, "");
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
async function searchReference(reference) {
  setBusy(true);
  setStatus("Looking up " + reference + "…");
  ui.verses.replaceChildren();
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
    displayMode = "passage";
    renderVerses(currentVerses, "");
    updateTitle(data.reference || reference);
    updateLabels();
    ui.fullChapter.hidden = false;
    ui.input.value = reference;
    setStatus("");
  } catch (error) {
    setStatus(error.message + " You can also choose a book and chapter from the browse panel.", true);
  } finally {
    setBusy(false);
    updateLabels();
  }
}
function searchKeyword(term) {
  const needle = term.trim().toLowerCase();
  if (!needle) { setStatus("Enter a passage reference or keyword.", true); return; }
  const matches = currentVerses.filter(verse => verse.text.toLowerCase().includes(needle));
  displayMode = "keyword";
  updateTitle("Search: “" + term.trim() + "”");
  renderVerses(matches, term.trim());
  setStatus(matches.length + " matching verse" + (matches.length === 1 ? "" : "s") + " in " + currentBook.name + " " + currentChapter + ".");
}
ui.testament.addEventListener("change", () => { populateBooks(currentBook.name); loadChapter(currentBook,1); });
ui.book.addEventListener("change", () => {
  const selected = findBook(ui.book.value);
  if (selected) { currentBook = selected; populateChapters(1); loadChapter(currentBook,1); }
});
ui.chapter.addEventListener("change", () => loadChapter(currentBook,Number(ui.chapter.value)));
ui.translation.addEventListener("change", () => {
  if (displayMode === "passage" && ui.input.value.trim()) searchReference(ui.input.value.trim());
  else loadChapter(currentBook,currentChapter);
});
ui.form.addEventListener("submit", event => {
  event.preventDefault();
  const query = ui.input.value.trim();
  if (!query) { setStatus("Enter a passage reference or keyword.",true); return; }
  if (/\d/.test(query) && /\d\s*(?::|$)/.test(query)) searchReference(query);
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
populateBooks("Genesis"); populateChapters(1); loadChapter(currentBook,1);
