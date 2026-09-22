(() => {
    'use strict';

    // ==== Guard: if overlay already exists, just focus it and exit ============
    const QUIZ_OVERLAY_ID = 'student-quiz-overlay';
    const EXISTING = document.getElementById(QUIZ_OVERLAY_ID);
    if (EXISTING) {
        const input = EXISTING.querySelector('#student-name-guess');
        if (input) { input.focus(); input.select(); }
        return;
    }

    // ==== Settings ============================================================
    const NAME_COLUMNS = 5;          // columns in the name panel
    const AUTO_NEXT_DELAY_MS = 600;  // pause after a correct click before moving on

    // ==== Utilities ===========================================================
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const normalize = (s) =>
        (s ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const firstNameOf = (fullName) => (fullName ?? '').trim().split(/\s+/)[0] ?? '';

    // ==== Algorithm State =====================================================
    // Weights track how "hard" a student is. Higher = shows up more often.
    let studentWeights = {};

    // ==== Extract students ====================================================
    const idSpans = $$('[id^="DisplayResult_SearchResultCtl_SearchDataList_lblLoginName_"]');
    const nameSpans = $$('[id^="DisplayResult_SearchResultCtl_SearchDataList_lblObjectName_"]');

    const allStudents = idSpans.map((span, i) => {
        const name = nameSpans[i]?.textContent?.trim();
        return {
            id: span?.textContent?.trim(),
            name,
            first: firstNameOf(name),   // only the very first name is used in the UI
        };
    }).filter(s => s.id && s.name);

    if (!allStudents.length) {
        console.warn('No students found. Check the selectors.');
    }

    // Students removed from practice (remembered in this browser between sessions)
    const REMOVED_KEY = 'studentQuizRemovedIds';
    let removedIds = new Set();
    try { removedIds = new Set(JSON.parse(localStorage.getItem(REMOVED_KEY) || '[]')); } catch (e) { /* ignore */ }
    const saveRemoved = () => {
        try { localStorage.setItem(REMOVED_KEY, JSON.stringify([...removedIds])); } catch (e) { /* ignore */ }
    };

    // Active set = everyone not removed with the × button
    let students = allStudents.filter(s => !removedIds.has(s.id));

    // Students answered correctly this round: they leave the list until "Restore Active Set"
    const learnedIds = new Set();
    const remainingStudents = () => students.filter(s => !learnedIds.has(s.id));

    // Phase 1 Queue: A copy of all students to cycle through first
    let unseenStudents = [...students];

    // ==== Weighted Logic ======================================================
    function getWeight(id) {
        return studentWeights[id] !== undefined ? studentWeights[id] : 20;
    }

    function adjustWeight(id, isCorrect) {
        let w = getWeight(id);
        if (isCorrect) {
            w = Math.max(1, w - 5);   // Correct: shows less often
        } else {
            w = w + 15;               // Wrong: shows MORE often
        }
        studentWeights[id] = w;
    }

    function pickWeightedStudent(availableStudents, currentId) {
        let pool = availableStudents;
        if (availableStudents.length > 1 && currentId) {
            pool = availableStudents.filter(s => s.id !== currentId);
        }
        const totalWeight = pool.reduce((sum, s) => sum + getWeight(s.id), 0);
        let randomPointer = Math.random() * totalWeight;
        for (const student of pool) {
            const w = getWeight(student.id);
            if (randomPointer < w) return student;
            randomPointer -= w;
        }
        return pool[0];
    }

    // ==== Hidden iframe (loader) ==============================================
    let loaderIframe = document.getElementById('infoPage');
    if (!loaderIframe) {
        loaderIframe = document.createElement('iframe');
        loaderIframe.id = 'infoPage';
        document.body.appendChild(loaderIframe);
    }
    loaderIframe.setAttribute('aria-hidden', 'true');
    loaderIframe.style.display = 'none';

    // ==== Styles ==============================================================
    document.getElementById('student-quiz-style')?.remove(); // replace styles from older versions
    const styleEl = document.createElement('style');
    styleEl.id = 'student-quiz-style';
    styleEl.textContent = `
      #student-quiz-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;overflow:auto;padding:16px;box-sizing:border-box;background:rgba(10,10,10,.75);font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
      #student-quiz-overlay *{box-sizing:border-box}
      #student-quiz-layout{margin:auto;display:flex;flex-wrap:wrap;gap:20px;align-items:stretch;justify-content:center;max-width:100%}
      #student-quiz-card,#student-names-panel{background:#fff;color:#111;padding:24px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
      #student-quiz-card{position:relative;width:min(460px,92vw);display:grid;gap:16px;justify-items:center;align-content:start}
      #student-names-panel{width:min(680px,92vw);display:flex;flex-direction:column;gap:12px}
      #student-names-title{font-size:1rem;font-weight:700}
      #student-names-grid{display:grid;grid-auto-flow:column;grid-template-columns:repeat(${NAME_COLUMNS},minmax(0,1fr));gap:4px 8px}
      .name-cell{position:relative;min-width:0}
      .name-btn{width:100%;padding:7px 26px 7px 10px;border-radius:8px;border:1px solid #e3e3e3;background:#fafafa;color:#111;font-size:14px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .12s ease,border-color .12s ease}
      .name-btn:hover{background:#eee;border-color:#ccc}
      .name-btn.is-correct{background:#d9f5df;border-color:#2e9e4a;color:#14532d;font-weight:700}
      .name-btn.is-wrong{background:#fde2e2;border-color:#d64545;color:#7f1d1d}
      .name-del{position:absolute;top:50%;right:4px;transform:translateY(-50%);width:20px;height:20px;padding:0;border:none;border-radius:50%;background:transparent;color:#aaa;font-size:14px;line-height:20px;text-align:center;cursor:pointer}
      .name-del:hover{background:#d64545;color:#fff}
      #student-names-header{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
      #restore-names{background:none;border:none;padding:0;font-size:13px;color:#06c;text-decoration:underline;cursor:pointer}
      #restore-names[hidden]{display:none}
      #student-names-tools{display:flex;align-items:center;gap:14px}
      #restore-active{padding:6px 12px;border-radius:8px;border:1px solid #ccc;background:#f4f4f4;color:#111;font-size:13px;font-weight:600;cursor:pointer}
      #restore-active:hover{background:#e6e6e6}
      #student-names-grid.locked .name-btn{cursor:default}
      #student-names-grid.locked .name-btn:not(.is-correct):not(.is-wrong){opacity:.55}
      #student-quiz-title{font-size:1.25rem;font-weight:700}
      #studentPhoto{width:220px;height:220px;object-fit:cover;border-radius:12px;box-shadow:0 6px 16px rgba(0,0,0,.2);background:#f2f2f2}
      #quiz-controls{display:grid;grid-template-columns:1fr auto;gap:8px;width:100%}
      #student-name-guess{padding:12px 14px;border-radius:10px;border:1px solid #ddd;width:100%;font-size:16px}
      #quiz-suggest{width:100%;min-height:26px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px;color:#666}
      .suggest-chip{padding:3px 9px;border-radius:999px;background:#f0f0f0;color:#333;cursor:pointer;border:1px solid transparent}
      .suggest-chip:hover{background:#e2e2e2}
      .suggest-chip.single{background:#d9f5df;border-color:#2e9e4a;color:#14532d;font-weight:700}
      .suggest-more{color:#999}
      #student-names-grid.filtering .name-btn:not(.matches){opacity:.25}
      .quiz-btn{padding:12px 14px;border-radius:10px;border:none;cursor:pointer;font-weight:600;background:#111;color:#fff;transition:transform .06s ease, box-shadow .2s ease}
      .quiz-btn:active{transform:translateY(1px)}
      .quiz-btn.secondary{background:#eee;color:#111}
      .quiz-btn.primary{box-shadow:0 0 0 2px #111 inset, 0 0 0 0 rgba(0,0,0,0)}
      .pulse{animation:pulse 1.2s infinite}
      @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(0,0,0,.25)}70%{box-shadow:0 0 0 10px rgba(0,0,0,0)}100%{box-shadow:0 0 0 0 rgba(0,0,0,0)}}
      .enter-icon{font-size:0.9em;margin-left:6px}
      #quiz-actions{display:flex;gap:8px;width:100%}
      #quiz-actions .quiz-btn{flex:1}
      #quiz-result{min-height:28px;font-size:1rem;font-weight:600;text-align:center}
      #quiz-footer{width:100%;display:flex;justify-content:space-between;align-items:center;font-size:0.9rem;color:#555}
      #close-quiz{position:absolute;top:10px;right:10px;background:transparent;border:none;font-size:22px;line-height:1;color:#666;cursor:pointer}
      #close-quiz:hover{color:#111}
      #quiz-credits{font-size:12px;color:#666;margin-top:4px;width:100%;text-align:right}
      #quiz-credits a{color:#06c;text-decoration:underline;cursor:pointer}
    `;
    document.head.appendChild(styleEl);

    // ==== Overlay UI ==========================================================
    const quizOverlayEl = document.createElement('div');
    quizOverlayEl.id = QUIZ_OVERLAY_ID;
    quizOverlayEl.innerHTML = `
    <div id="student-quiz-layout">
      <div id="student-quiz-card" role="dialog" aria-modal="true" aria-labelledby="student-quiz-title">
        <button id="close-quiz" aria-label="Close">✕</button>
        <div id="quiz-header" style="text-align:center;">
          <div id="student-quiz-title">Benjamin’s Students Quiz</div>
        </div>
        <img id="studentPhoto" alt="Student photo" decoding="async" loading="eager" />
        <div id="quiz-controls">
          <input id="student-name-guess" name="guess"
                 placeholder="First name?" autocomplete="off" />
          <button id="guess-btn" class="quiz-btn">Guess <span class="enter-icon">↵</span></button>
        </div>
        <div id="quiz-suggest" aria-live="polite"></div>
        <div id="quiz-actions">
          <button id="next-btn" class="quiz-btn secondary" title="Show another student">Next</button>
          <button id="reveal-btn" class="quiz-btn secondary" title="Reveal the answer">Reveal</button>
        </div>
        <div id="quiz-result" aria-live="polite"></div>
        <div id="quiz-footer">
          <div id="quiz-score">Score: <span id="score-correct">0</span>/<span id="score-total">0</span></div>
          <div id="quiz-progress"></div>
        </div>
        <div id="quiz-credits">Lavet af <a href="https://www.linkedin.com/in/benjamindalshughes/" target="_blank" rel="noopener noreferrer">Benjamin Hughes</a></div>
      </div>
      <div id="student-names-panel" aria-label="Student names">
        <div id="student-names-header">
          <div id="student-names-title">Click a name</div>
          <div id="student-names-tools">
            <button id="restore-names" type="button" hidden></button>
            <button id="restore-active" type="button" title="Bring back every name you have guessed correctly (not the ones removed with ×)">Restore Active Set</button>
          </div>
        </div>
        <div id="student-names-grid"></div>
      </div>
    </div>
  `;
    document.body.appendChild(quizOverlayEl);

    // Close handlers
    quizOverlayEl.addEventListener('click', (e) => {
        if (e.target === quizOverlayEl) closeOverlay();
    });
    // Global key handler: works no matter which element has focus
    const escHandler = (e) => {
        if (e.key === 'Escape') { closeOverlay(); return; }
        if (e.key !== 'Enter' || e.repeat) return;
        if (!awaitingGuess) {
            // Already answered: Enter always means Next
            e.preventDefault();
            nextStudent();
        } else if (document.activeElement === nameInput) {
            e.preventDefault();
            checkAnswer();
        } else if (!document.activeElement?.closest?.('#' + QUIZ_OVERLAY_ID + ' button')) {
            // Focus got lost somewhere: bring it back to the text field
            e.preventDefault();
            nameInput.focus();
        }
    };
    document.addEventListener('keydown', escHandler, true);
    let autoNextTimer = null;
    function closeOverlay() {
        clearTimeout(autoNextTimer);
        document.removeEventListener('keydown', escHandler, true);
        quizOverlayEl.remove();
    }

    // Refs
    const imgEl = document.getElementById('studentPhoto');
    const nameInput = document.getElementById('student-name-guess');
    const guessBtn = document.getElementById('guess-btn');
    const nextBtn = document.getElementById('next-btn');
    const revealBtn = document.getElementById('reveal-btn');
    const resultEl = document.getElementById('quiz-result');
    const scoreCorrectEl = document.getElementById('score-correct');
    const scoreTotalEl = document.getElementById('score-total');
    const progressEl = document.getElementById('quiz-progress');
    const namesGridEl = document.getElementById('student-names-grid');
    const suggestEl = document.getElementById('quiz-suggest');
    document.getElementById('close-quiz').addEventListener('click', closeOverlay);

    const restoreBtn = document.getElementById('restore-names');

    // Name panel: 5 aligned columns, alphabetical going down each column.
    // Re-rendered whenever a name is removed, so the list collapses neatly.
    const nameButtons = new Map(); // normalized first name -> button
    function renderNameGrid() {
        // Unique first names (two "Emil"s share one button)
        const seen = new Set();
        const firstNames = [];
        const visible = students.filter(s => !learnedIds.has(s.id) || s === currentStudent);
        for (const s of visible) {
            const key = normalize(s.first);
            if (!seen.has(key)) { seen.add(key); firstNames.push(s.first); }
        }
        firstNames.sort((a, b) => a.localeCompare(b, 'da'));

        namesGridEl.textContent = '';
        nameButtons.clear();
        const rowCount = Math.max(1, Math.ceil(firstNames.length / NAME_COLUMNS));
        namesGridEl.style.gridTemplateRows = `repeat(${rowCount}, auto)`;

        firstNames.forEach((first) => {
            const cell = document.createElement('div');
            cell.className = 'name-cell';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'name-btn';
            btn.textContent = first;
            btn.title = first;
            btn.addEventListener('click', () => handleNameClick(first, btn));

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'name-del';
            del.textContent = '×';
            del.title = `Remove ${first} from practice`;
            del.setAttribute('aria-label', `Remove ${first} from practice`);
            del.addEventListener('click', (e) => { e.stopPropagation(); removeFirstName(first); });

            cell.append(btn, del);
            namesGridEl.appendChild(cell);
            nameButtons.set(normalize(first), btn);
        });

        restoreBtn.hidden = removedIds.size === 0;
        restoreBtn.textContent = `Restore removed (${removedIds.size})`;
    }

    function updateProgress() {
        progressEl.textContent = `${remainingStudents().length} of ${students.length} left`;
    }

    // Remove everyone with this first name from practice
    function removeFirstName(first) {
        const key = normalize(first);
        const isGone = (s) => normalize(s.first) === key;
        students.filter(isGone).forEach((s) => removedIds.add(s.id));
        saveRemoved();
        students = students.filter((s) => !isGone(s));
        unseenStudents = unseenStudents.filter((s) => !isGone(s));
        renderNameGrid();

        if (currentStudent && isGone(currentStudent)) {
            nextStudent();                 // the person on screen was removed
        } else {
            if (currentStudent && !awaitingGuess) highlightCorrectName();
            updateProgress();
        }
    }

    // Restore Active Set: start a fresh round with everyone not removed by ×
    document.getElementById('restore-active').addEventListener('click', () => {
        learnedIds.clear();
        unseenStudents = students.filter((s) => s !== currentStudent); // everyone gets shown again
        if (!currentStudent) { nextStudent(); return; }
        renderNameGrid();
        if (!awaitingGuess) highlightCorrectName();
        updateProgress();
    });

    restoreBtn.addEventListener('click', () => {
        const restored = allStudents.filter((s) => removedIds.has(s.id));
        restored.forEach((s) => learnedIds.delete(s.id));
        removedIds.clear();
        saveRemoved();
        students = [...allStudents];
        unseenStudents.push(...restored);  // restored students count as not yet seen
        renderNameGrid();
        if (!currentStudent) nextStudent();
        else {
            if (!awaitingGuess) highlightCorrectName();
            updateProgress();
        }
    });

    // ==== State ===============================================================
    let currentStudent = null;
    let scoreCorrect = 0;
    let scoreTotal = 0;
    let awaitingGuess = true;
    let revealActsAsNext = false; // once the name is known, the Reveal button works as Next
    let revealedAt = 0;

    function setPrimaryAction(which) {
        const makePrimary = (btn) => {
            btn.classList.remove('secondary');
            btn.classList.add('primary', 'pulse');
        };
        const makeSecondary = (btn) => {
            btn.classList.add('secondary');
            btn.classList.remove('primary', 'pulse');
        };
        if (which === 'guess') {
            makePrimary(guessBtn);
            if (!guessBtn.querySelector('.enter-icon')) guessBtn.insertAdjacentHTML('beforeend', ' <span class="enter-icon">↵</span>');
            if (nextBtn.querySelector('.enter-icon')) nextBtn.querySelector('.enter-icon').remove();
            makeSecondary(nextBtn);
            awaitingGuess = true;
            namesGridEl.classList.remove('locked');
            updateSuggestions();
            revealActsAsNext = false;
            revealBtn.textContent = 'Reveal';
            revealBtn.title = 'Reveal the answer';
        } else {
            makePrimary(nextBtn);
            if (!nextBtn.querySelector('.enter-icon')) nextBtn.insertAdjacentHTML('beforeend', ' <span class="enter-icon">↵</span>');
            if (guessBtn.querySelector('.enter-icon')) guessBtn.querySelector('.enter-icon').remove();
            makeSecondary(guessBtn);
            awaitingGuess = false;
            namesGridEl.classList.add('locked');
            updateSuggestions();
            // Name is now known (guess, click or reveal): Reveal button works as Next
            revealActsAsNext = true;
            revealedAt = Date.now();
            revealBtn.textContent = 'Next';
            revealBtn.title = 'Show another student';
        }
    }

    function clearNameHighlights() {
        nameButtons.forEach((btn) => btn.classList.remove('is-correct', 'is-wrong'));
    }

    // ==== Live suggestions while typing ======================================
    const MAX_CHIPS = 6;
    function visibleFirstNames() {
        return [...nameButtons.values()].map((btn) => btn.textContent);
    }
    function matchingNames(typed) {
        const t = normalize(typed);
        if (!t) return [];
        return visibleFirstNames().filter((n) => normalize(n).startsWith(t));
    }
    function updateSuggestions() {
        const typed = nameInput.value;
        const matches = awaitingGuess ? matchingNames(typed) : [];
        suggestEl.textContent = '';
        namesGridEl.classList.toggle('filtering', awaitingGuess && normalize(typed).length > 0);
        nameButtons.forEach((btn, key) => {
            btn.classList.toggle('matches', matches.some((n) => normalize(n) === key));
        });
        if (!awaitingGuess || !normalize(typed)) return;
        if (!matches.length) {
            suggestEl.textContent = 'No name starts with that';
            return;
        }
        matches.slice(0, MAX_CHIPS).forEach((n) => {
            const chip = document.createElement('span');
            chip.className = 'suggest-chip' + (matches.length === 1 ? ' single' : '');
            chip.textContent = n;
            chip.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
            chip.addEventListener('click', () => { nameInput.value = n; checkAnswer(); });
            suggestEl.appendChild(chip);
        });
        if (matches.length > MAX_CHIPS) {
            const more = document.createElement('span');
            more.className = 'suggest-more';
            more.textContent = `+${matches.length - MAX_CHIPS} more`;
            suggestEl.appendChild(more);
        }
    }
    nameInput.addEventListener('input', updateSuggestions);

    function highlightCorrectName() {
        nameButtons.get(normalize(currentStudent.first))?.classList.add('is-correct');
    }

    function updateScore() {
        scoreCorrectEl.textContent = String(scoreCorrect);
        scoreTotalEl.textContent = String(scoreTotal);
    }

    // ==== Load student image ==================================================
    function loadStudentImage(student) {
        const url = `../include/InfoPage.aspx?login=${encodeURIComponent(student.id)}&type=S`;
        return new Promise((resolve, reject) => {
            const onLoad = () => {
                try {
                    const doc = loaderIframe.contentDocument || loaderIframe.contentWindow?.document;
                    if (!doc) throw new Error('No iframe document');
                    const img = doc.querySelector('img');
                    if (!img) return reject(new Error('No <img> found in iframe'));
                    resolve(img.src);
                } catch (err) { reject(err); }
                finally { loaderIframe.removeEventListener('load', onLoad); }
            };
            loaderIframe.addEventListener('load', onLoad, { once: true });
            loaderIframe.src = url;
        });
    }

    async function showStudent(student) {
        currentStudent = student;
        resultEl.textContent = '';
        nameInput.value = '';
        imgEl.src = '';
        imgEl.alt = 'Loading...';
        renderNameGrid(); // names already guessed correctly drop out here
        updateProgress();

        setPrimaryAction('guess');
        try {
            const imgSrc = await loadStudentImage(student);
            if (currentStudent === student) imgEl.src = imgSrc; // ignore stale loads
        } catch (e) {
            if (currentStudent !== student) return;
            resultEl.textContent = 'Could not load image. Try Next.';
            setPrimaryAction('next');
        }
    }

    // ==== Logic ===============================================================
    // Typed answer: first name only, first 4 letters are enough
    function checkAnswer() {
        if (!currentStudent || !awaitingGuess) return;
        const matches = matchingNames(nameInput.value);
        if (matches.length === 1) nameInput.value = matches[0]; // complete the single match
        const guessFirst = normalize(nameInput.value).split(/\s+/)[0];
        const firstName = normalize(currentStudent.first);
        scoreTotal += 1;

        const isCorrect = firstName.length <= 4
            ? guessFirst === firstName                          // short names (Bo, Ida, Emil): must match fully
            : guessFirst.slice(0, 4) === firstName.slice(0, 4); // otherwise the first 4 letters are enough

        if (isCorrect) {
            scoreCorrect += 1;
            resultEl.textContent = `Correct 🎉 — ${currentStudent.first}`;
            adjustWeight(currentStudent.id, true);
            learnedIds.add(currentStudent.id); // done for this round; leaves the list on Next
        } else {
            resultEl.textContent = `Wrong 😭 — It’s ${currentStudent.first}`;
            adjustWeight(currentStudent.id, false);
        }
        highlightCorrectName();
        updateScore();
        nameInput.focus(); nameInput.select();
        setPrimaryAction('next');
    }

    // Clicked answer in the name panel
    function handleNameClick(clickedFirst, btn) {
        if (!currentStudent || !awaitingGuess) return;
        scoreTotal += 1;
        const isCorrect = normalize(clickedFirst) === normalize(currentStudent.first);

        if (isCorrect) {
            // Correct: brief green flash, then move on automatically
            scoreCorrect += 1;
            adjustWeight(currentStudent.id, true);
            learnedIds.add(currentStudent.id); // done for this round; leaves the list on Next
            resultEl.textContent = `Correct 🎉 — ${currentStudent.first}`;
            btn.classList.add('is-correct');
            updateScore();
            setPrimaryAction('next'); // locks the panel during the short pause
            autoNextTimer = setTimeout(nextStudent, AUTO_NEXT_DELAY_MS);
        } else {
            // Wrong: mark the click, show + fill in the right name, wait for manual Next
            adjustWeight(currentStudent.id, false);
            resultEl.textContent = `Wrong 😭 — It’s ${currentStudent.first}`;
            btn.classList.add('is-wrong');
            highlightCorrectName();
            nameInput.value = currentStudent.first;
            updateScore();
            setPrimaryAction('next');
            nameInput.focus(); nameInput.select(); // Enter now means Next
        }
    }

    function nextStudent() {
        clearTimeout(autoNextTimer);
        if (!students.length) {
            currentStudent = null;
            imgEl.removeAttribute('src');
            imgEl.alt = '';
            nameInput.value = '';
            resultEl.textContent = 'No students left to practice.';
            progressEl.textContent = '';
            renderNameGrid();
            return;
        }

        const remaining = remainingStudents();
        if (!remaining.length) {
            // Every name has been guessed correctly once
            currentStudent = null;
            imgEl.removeAttribute('src');
            imgEl.alt = '';
            nameInput.value = '';
            resultEl.textContent = 'All names guessed 🎉 — press “Restore Active Set” to go again.';
            renderNameGrid();
            updateProgress();
            return;
        }

        let candidate;
        if (unseenStudents.length > 0) {
            // Phase 1: go through everyone randomly first
            const randomIndex = Math.floor(Math.random() * unseenStudents.length);
            candidate = unseenStudents[randomIndex];
            unseenStudents.splice(randomIndex, 1);
        } else {
            // Phase 2: weighted algorithm
            candidate = pickWeightedStudent(remaining, currentStudent?.id);
        }
        showStudent(candidate);
        nameInput.focus();
    }

    // ==== Events ==============================================================
    guessBtn.addEventListener('click', checkAnswer);
    nextBtn.addEventListener('click', nextStudent);
    revealBtn.addEventListener('click', () => {
        if (!currentStudent) return;
        if (revealActsAsNext) {
            // Ignore the 2nd click of an accidental double-click right after revealing
            if (Date.now() - revealedAt > 350) nextStudent();
            return;
        }
        if (!awaitingGuess) return;
        resultEl.textContent = `It’s ${currentStudent.first}`;
        nameInput.value = currentStudent.first;
        adjustWeight(currentStudent.id, false); // Count as 'hard'
        highlightCorrectName();
        setPrimaryAction('next');
        nameInput.focus(); nameInput.select();
    });

    // Clicking in the name panel must not steal keyboard focus from the text field
    namesGridEl.addEventListener('mousedown', (e) => e.preventDefault());

    // ==== Start ===============================================================
    renderNameGrid();
    nextStudent();
    nameInput.focus();
})();
