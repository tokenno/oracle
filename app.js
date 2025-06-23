console.log("app.js loaded");

window.showStatus = window.showStatus || ((message, type) => console.log(`Status: ${message} (${type})`));

const fileInputsContainer = document.getElementById('file-inputs');
const uploadArea = fileInputsContainer?.querySelector('.upload-area');
const trackCountInput = document.getElementById('track-count');
const processBtn = document.getElementById('process-btn');
let trackCount = parseInt(trackCountInput?.value) || 5;

if (!fileInputsContainer || !uploadArea || !trackCountInput || !processBtn) {
    console.error('Required elements missing:', { fileInputsContainer, uploadArea, trackCountInput, processBtn });
    window.showStatus('UI elements not found. Check console.', 'error');
    throw new Error('Initialization failed');
}

let audioBuffers = [];
let isPlaying = false;
let audioContext = null;
let activeSources = [];
let loopScheduler = null;
const MAX_LOOPS = 100;
let markovChain = null;
let fileMetadata = new Map();
let projectBPM = 120;
let processingQueue = [];
let isProcessing = false;
const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
    melodicMinor: [0, 2, 3, 5, 7, 9, 11],
    pentatonic: [0, 2, 4, 7, 9],
    blues: [0, 3, 5, 6, 7, 10],
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

function showStatus(message, type) {
    const statusDisplay = document.getElementById('status-display');
    if (statusDisplay) {
        statusDisplay.innerHTML = `<div class="status-message ${type}">${message}</div>`;
        statusDisplay.style.display = 'block';
        setTimeout(() => statusDisplay.style.display = 'none', 3000);
    } else {
        console.log(`Status: ${message} (${type})`);
    }
}

async function adjustToScale(files, scaleName, behavior) {
    if (scaleName === 'none' || !SCALES[scaleName]) return files;
    const scale = SCALES[scaleName];
    if (behavior === 'reorder') {
        // NEW: Implement reorder behavior by sorting files by their root note
        const sortedFiles = [...files].map((file, index) => {
            const metadata = fileMetadata.get(file.name);
            let key = metadata?.key || extractKeyFromFilename(file.name);
            if (!key || key === 'Unknown') key = 'C'; // Default to C if unknown
            const rootNote = noteToMidi(key.split(' ')[0]);
            return { file, rootNote: rootNote !== null ? rootNote % 12 : 0, index };
        }).sort((a, b) => {
            // Sort by root note, prioritizing scale notes
            const aInScale = scale.includes(a.rootNote);
            const bInScale = scale.includes(b.rootNote);
            if (aInScale && !bInScale) return -1;
            if (!aInScale && bInScale) return 1;
            return a.rootNote - b.rootNote;
        }).map(item => item.file);
        return sortedFiles;
    }
    const results = await Promise.all(files.map(async file => {
        const metadata = fileMetadata.get(file.name);
        if (!metadata) return behavior === 'filter' ? null : file;
        let key = metadata.key;
        if (!key || key === 'Unknown') key = extractKeyFromFilename(file.name);
        if (!key || key === 'Unknown') return behavior === 'filter' ? null : file;
        const rootNote = noteToMidi(key.split(' ')[0]);
        if (rootNote === null) return behavior === 'filter' ? null : file;
        const fileNote = rootNote % 12;
        if (behavior === 'filter') return scale.includes(fileNote) ? file : null;
        if (behavior === 'transpose') {
            const nearestNote = findNearestScaleNote(fileNote, scale);
            const transposeAmount = nearestNote - fileNote;
            if (transposeAmount !== 0) return await transposeBuffer(file, transposeAmount);
            return file;
        }
        return file;
    }));
    return results.filter(file => file !== null);
}

function extractKeyFromFilename(filename) {
    const patterns = [
        /([A-Ga-g]#?\d)/,
        /(key of [A-Ga-g]#?)/i,
        /([A-Ga-g]#? major)/i,
        /([A-Ga-g]#? minor)/i
    ];
    for (const pattern of patterns) {
        const match = filename.match(pattern);
        if (match) return match[1].toUpperCase();
    }
    return 'Unknown';
}

function findNearestScaleNote(note, scale) {
    let minDist = Infinity;
    let nearestNote = note;
    for (const scaleNote of scale) {
        const dist = Math.min(
            Math.abs(note - scaleNote),
            Math.abs(note - (scaleNote + 12)),
            Math.abs(note - (scaleNote - 12))
        );
        if (dist < minDist) {
            minDist = dist;
            nearestNote = scaleNote;
        }
    }
    return nearestNote;
}

function noteToMidi(note) {
    if (!note) return null;
    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const match = note.toString().match(/^([A-Ga-g]#?)(-?\d+)?/);
    if (!match) return null;
    const [, noteName, octave] = match;
    const noteIndex = notes.indexOf(noteName.toUpperCase());
    if (noteIndex === -1) return null;
    const octaveNum = octave ? parseInt(octave) : 4;
    return noteIndex + (octaveNum + 1) * 12;
}

function updateProcessButtonState() {
    const processBtn = document.getElementById('process-btn');
    const fileInputs = fileInputsContainer.querySelectorAll('input[type="file"]');
    let validBuffers = 0;
    let totalFiles = 0;
    fileInputs.forEach((input, i) => {
        if (input.files.length > 0) {
            totalFiles++;
            if (audioBuffers[i] && audioBuffers[i].duration > 0 && audioBuffers[i].sampleRate > 0 && audioBuffers[i].numberOfChannels > 0 && audioBuffers[i].name) {
                validBuffers++;
                input.classList.remove('invalid');
                input.classList.add('valid');
            } else {
                input.classList.remove('valid');
                input.classList.add('invalid');
            }
        } else {
            input.classList.remove('valid', 'invalid');
        }
    });
    processBtn.disabled = validBuffers === 0 || validBuffers < totalFiles;
    console.log(`app.js: Process button state - Valid: ${validBuffers}, Total: ${totalFiles}, Disabled: ${processBtn.disabled}`);
    if (validBuffers === 0) {
        showStatus(totalFiles > 0 ? 'No valid audio files loaded. Check file formats.' : 'Please upload audio files to process.', 'error');
    } else {
        showStatus(`${validBuffers} valid audio file(s) loaded.`, 'info');
    }
}

async function processFile(file, index) {
    const fileInputDiv = fileInputsContainer.querySelector(`#file-input-${index}`)?.parentElement;
    const fileNameSpan = fileInputDiv?.querySelector('.file-name');
    const fileErrorSpan = fileInputDiv?.querySelector('.file-error');
    const fileBpmSpan = fileInputDiv?.querySelector('.file-bpm');
    const loopInput = fileInputDiv?.querySelector(`#loop-input-${index}`);
    
    if (!fileNameSpan || !fileErrorSpan || !fileBpmSpan || !loopInput) {
        console.error(`app.js: Missing spans or loop input for file input ${index}`);
        return;
    }

    try {
        if (!file.type.startsWith('audio/')) {
            throw new Error('Invalid file type. Please upload audio files (e.g., WAV, OGG, MP3).');
        }
        console.log(`Processing file ${file.name} at index ${index}`);
        fileNameSpan.textContent = file.name;
        fileErrorSpan.textContent = 'Processing...';

        audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await file.arrayBuffer();
        let audioBuffer;
        const startTime = performance.now();
        try {
            audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        } catch (decodeError) {
            console.warn(`Decode error for ${file.name}, retrying with OfflineAudioContext...`, decodeError);
            const offlineContext = new OfflineAudioContext(2, Math.min(arrayBuffer.byteLength, 44100 * 60), 44100);
            audioBuffer = await offlineContext.decodeAudioData(arrayBuffer);
        }
        if (!audioBuffer.sampleRate || !audioBuffer.numberOfChannels || audioBuffer.duration <= 0) {
            throw new Error('Invalid audio buffer: missing sampleRate, channels, or duration');
        }
        audioBuffer.name = file.name;
        audioBuffers[index] = audioBuffer;

        let metadata = { bpm: 120, key: 'Unknown', isLoop: loopInput.checked, centerFreq: 0 };
        try {
            if (typeof musicMetadata !== 'undefined' && file.size < 10 * 1024 * 1024) {
                const musicMeta = await musicMetadata.parseBlob(file);
                metadata.bpm = musicMeta.common.bpm || await detectBPM(file, true);
                metadata.key = musicMeta.common.key || 'Unknown';
            } else {
                console.warn(`app.js: Skipping musicMetadata for large file ${file.name}`);
                metadata.key = extractKeyFromFilename(file.name);
                metadata.bpm = await detectBPM(file, true);
            }
        } catch (metaError) {
            console.warn(`Metadata error for ${file.name}, using fallbacks:`, metaError);
            metadata.key = extractKeyFromFilename(file.name);
            metadata.bpm = await detectBPM(file, true);
        }
        try {
            metadata.centerFreq = await getFFTCenterFrequency(audioBuffer, 30);
            console.log(`Center frequency for ${file.name}: ${metadata.centerFreq.toFixed(1)}Hz`);
        } catch (freqError) {
            console.warn(`Couldn't calculate center frequency for ${file.name}:`, freqError);
            metadata.centerFreq = 0;
        }
        fileMetadata.set(file.name, metadata);
        fileBpmSpan.textContent = `BPM: ${metadata.bpm}, Key: ${metadata.key}, Freq: ${metadata.centerFreq.toFixed(0)}Hz, Type: ${metadata.isLoop ? 'Loop' : 'One-Shot'}`;
        drawWaveformPerFile(audioBuffer, index);
        updateProcessButtonState();
        console.log(`app.js: Processed ${file.name} in ${(performance.now() - startTime).toFixed(2)}ms`);
    } catch (error) {
        console.error(`Error processing file ${file.name}:`, error);
        fileErrorSpan.textContent = `Error: ${error.message}`;
        audioBuffers[index] = null;
        updateProcessButtonState();
    }
}

async function detectBPM(file, optimize = false) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        const channelData = audioBuffer.getChannelData(0);
        const sampleRate = audioBuffer.sampleRate;
        const maxSamples = optimize ? Math.min(channelData.length, sampleRate * 30) : channelData.length;
        const downsampledRate = 4000;
        const downsamplingFactor = Math.floor(sampleRate / downsampledRate);
        const downsampledData = [];
        for (let i = 0; i < maxSamples; i += downsamplingFactor) {
            downsampledData.push(channelData[i]);
        }
        const filteredData = highPassFilter(downsampledData, downsampledRate, 100);
        const autocorrelation = calculateAutocorrelation(filteredData);
        const peaks = findPeaks(autocorrelation);
        if (peaks.length === 0) return 120;
        const firstPeak = peaks[0];
        const beatPeriod = firstPeak / downsampledRate;
        const bpm = Math.round(60 / beatPeriod);
        return Math.max(60, Math.min(200, bpm));
    } catch (error) {
        console.error('BPM detection error:', error);
        return 120;
    }
}

async function getFFTCenterFrequency(buffer, maxSeconds = Infinity) {
    if (!buffer || buffer.numberOfChannels === 0) return 0;
    const maxSamples = Math.min(buffer.length, buffer.sampleRate * maxSeconds);
    const offlineCtx = new OfflineAudioContext(1, maxSamples, buffer.sampleRate);
    const source = offlineCtx.createBufferSource();
    const tempBuffer = offlineCtx.createBuffer(buffer.numberOfChannels, maxSamples, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
        tempBuffer.copyToChannel(buffer.getChannelData(c).slice(0, maxSamples), c);
    }
    source.buffer = tempBuffer;
    const analyser = offlineCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    source.start(0);
    await offlineCtx.startRendering();
    const dataArray = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(dataArray);
    let totalMagnitude = 0;
    let weightedSum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        const magnitude = Math.pow(10, dataArray[i] / 20);
        const freq = i * offlineCtx.sampleRate / analyser.fftSize;
        totalMagnitude += magnitude;
        weightedSum += freq * magnitude;
    }
    return totalMagnitude > 0 ? weightedSum / totalMagnitude : 0;
}

function highPassFilter(data, sampleRate, cutoff) {
    const RC = 1.0 / (2 * Math.PI * cutoff);
    const dt = 1.0 / sampleRate;
    const alpha = RC / (RC + dt);
    const filteredData = new Float32Array(data.length);
    filteredData[0] = data[0];
    for (let i = 1; i < data.length; i++) {
        filteredData[i] = alpha * (filteredData[i - 1] + data[i] - data[i - 1]);
    }
    return filteredData;
}

function calculateAutocorrelation(data) {
    const result = new Float32Array(data.length);
    for (let lag = 0; lag < data.length; lag++) {
        let sum = 0;
        for (let i = 0; i < data.length - lag; i++) {
            sum += data[i] * data[i + lag];
        }
        result[lag] = sum;
    }
    return result;
}

function findPeaks(data) {
    const peaks = [];
    for (let i = 1; i < data.length - 1; i++) {
        if (isPeak(data, i)) {
            peaks.push(i);
        }
    }
    return peaks.sort((a, b) => data[b] - data[a]);
}

function isPeak(data, index) {
    return data[index] > data[index - 1] && data[index] > data[index + 1];
}

async function transposeBuffer(file, semitones) {
    const arrayBuffer = await file.arrayBuffer();
    const offlineCtx = new OfflineAudioContext(2, arrayBuffer.byteLength, 44100);
    const buffer = await offlineCtx.decodeAudioData(arrayBuffer);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.pow(2, semitones / 12);
    source.connect(offlineCtx.destination);
    source.start(0);
    const renderedBuffer = await offlineCtx.startRendering();
    return renderedBuffer;
}

async function timestretchBuffer(buffer, factor) {
    const offlineCtx = new OfflineAudioContext(
        buffer.numberOfChannels,
        buffer.length / factor,
        buffer.sampleRate
    );
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = factor;
    source.connect(offlineCtx.destination);
    source.start(0);
    return await offlineCtx.startRendering();
}

function normalizeBuffer(buffer) {
    const channelData = [];
    let maxAmplitude = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < data.length; i++) {
            maxAmplitude = Math.max(maxAmplitude, Math.abs(data[i]));
        }
        channelData.push(data);
    }
    if (maxAmplitude > 0) {
        const scale = 0.8 / maxAmplitude;
        for (let c = 0; c < buffer.numberOfChannels; c++) {
            for (let i = 0; i < channelData[c].length; i++) {
                channelData[c][i] *= scale;
            }
        }
    }
    return buffer;
}

function drawWaveformPerFile(buffer, index) {
    const canvas = document.getElementById(`waveform-${index}`);
    if (!canvas) {
        console.warn(`app.js: Waveform canvas waveform-${index} not found`);
        return;
    }
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(123, 211, 247, 0.2)';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#f77bd3';
    ctx.lineWidth = 1;
    const channelData = buffer.getChannelData(0);
    const step = Math.ceil(channelData.length / width);
    ctx.beginPath();
    for (let i = 0; i < width; i++) {
        let min = 1;
        let max = -1;
        for (let j = 0; j < step; j++) {
            const sample = channelData[i * step + j] || 0;
            min = Math.min(min, sample);
            max = Math.max(max, sample);
        }
        const yMin = (1 - min) * height / 2;
        const yMax = (1 - max) * height / 2;
        ctx.moveTo(i, yMin);
        ctx.lineTo(i, yMax);
    }
    ctx.stroke();
}

function calculateDynamicBlend(index, total) {
    const cycleLength = Math.floor(total / 4);
    const cyclePosition = index % cycleLength;
    const blend = Math.sin((cyclePosition / cycleLength) * Math.PI);
    return 0.3 + blend * 0.7;
}

async function createReverbImpulseResponse(ctx, duration) {
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * duration;
    const impulse = ctx.createBuffer(2, length, sampleRate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);
    for (let i = 0; i < length; i++) {
        const decay = Math.exp(-i / (sampleRate * duration));
        left[i] = (Math.random() * 2 - 1) * decay;
        right[i] = (Math.random() * 2 - 1) * decay;
    }
    return normalizeBuffer(impulse);
}

function buildMarkovChain(files) {
    const chain = {};
    files.forEach((file, i) => {
        chain[i] = {};
        files.forEach((_, j) => {
            chain[i][j] = Math.random();
        });
        const sum = Object.values(chain[i]).reduce((a, b) => a + b, 0);
        Object.keys(chain[i]).forEach(k => {
            chain[i][k] /= sum;
        });
    });
    return chain;
}

function generateMarkovOrder(chain, length) {
    const order = [];
    let current = Math.floor(Math.random() * Object.keys(chain).length);
    for (let i = 0; i < length; i++) {
        order.push(current);
        const probs = chain[current];
        let rand = Math.random();
        let sum = 0;
        for (const next in probs) {
            sum += probs[next];
            if (rand < sum) {
                current = parseInt(next);
                break;
            }
        }
    }
    return order;
}

function getAlgorithmicOrder(files, algorithm, length) {
    const order = [];
    if (algorithm === 'random') {
        for (let i = 0; i < length; i++) {
            order.push(Math.floor(Math.random() * files.length));
        }
    } else if (algorithm === 'reverse') {
        for (let i = 0; i < length; i++) {
            order.push(files.length - 1 - (i % files.length));
        }
    } else if (algorithm === 'scale-ascending') {
        // NEW: Implement Scale Ascending by sorting files by root note
        const scaleName = document.getElementById('scale-select')?.value || 'none';
        const scale = SCALES[scaleName] || SCALES.chromatic; // Fallback to chromatic if none
        const sortedIndices = files.map((file, index) => {
            const metadata = fileMetadata.get(file.name);
            let key = metadata?.key || extractKeyFromFilename(file.name);
            if (!key || key === 'Unknown') key = 'C'; // Default to C
            const rootNote = noteToMidi(key.split(' ')[0]);
            return { index, rootNote: rootNote !== null ? rootNote % 12 : 0 };
        }).sort((a, b) => {
            const aInScale = scale.includes(a.rootNote);
            const bInScale = scale.includes(b.rootNote);
            if (aInScale && !bInScale) return -1;
            if (!aInScale && bInScale) return 1;
            return a.rootNote - b.rootNote;
        }).map(item => item.index);
        for (let i = 0; i < length; i++) {
            order.push(sortedIndices[i % sortedIndices.length]);
        }
    } else {
        for (let i = 0; i < length; i++) {
            order.push(i % files.length);
        }
    }
    return order;
}

async function createLoopingMix(processedFiles, wetDryMix, algorithm, loopDurationMinutes) {
    if (!processedFiles || processedFiles.length === 0) {
        console.error('app.js: No files provided for looping mix');
        return null;
    }
    const sampleRate = audioContext.sampleRate;
    // NEW: Calculate max loops based on loopDurationMinutes
    const loopDurationSeconds = loopDurationMinutes * 60;
    const beatDuration = (60 / projectBPM) * 4; // Duration of one loop segment (4 beats)
    const maxLoops = Math.min(MAX_LOOPS, Math.ceil(loopDurationSeconds / beatDuration));
    const maxDuration = Math.max(...processedFiles.map(f => f ? f.duration : 0)) * maxLoops;
    const offlineCtx = new OfflineAudioContext(2, maxDuration * sampleRate, sampleRate);
    const reverb = offlineCtx.createConvolver();
    const reverbBuffer = await createReverbImpulseResponse(offlineCtx, 2.0);
    reverb.buffer = reverbBuffer;
    const dryGain = offlineCtx.createGain();
    const wetGain = offlineCtx.createGain();
    dryGain.gain.value = 1 - wetDryMix;
    wetGain.gain.value = wetDryMix;
    const masterGain = offlineCtx.createGain();
    const masterGainValue = Math.min(0.8 / Math.sqrt(processedFiles.length), 0.8);
    masterGain.gain.value = masterGainValue;
    reverb.connect(wetGain);
    wetGain.connect(masterGain);
    dryGain.connect(masterGain);
    masterGain.connect(offlineCtx.destination);

    let order = [];
    if (algorithm === 'sequential') {
        order = Array.from({ length: maxLoops }, (_, i) => i % processedFiles.length);
    } else if (algorithm === 'markov') {
        if (!markovChain) markovChain = buildMarkovChain(processedFiles);
        order = generateMarkovOrder(markovChain, maxLoops);
    } else {
        order = getAlgorithmicOrder(processedFiles, algorithm, maxLoops);
    }

    for (let i = 0; i < order.length; i++) {
        const fileIndex = order[i];
        const buffer = processedFiles[fileIndex];
        if (!buffer) continue;
        const metadata = fileMetadata.get(buffer.name);
        if (!metadata) continue;
        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;
        source.loop = metadata.isLoop;
        if (metadata.isLoop) {
            source.loopStart = 0;
            source.loopEnd = buffer.duration;
        }
        const gainNode = offlineCtx.createGain();
        const startTime = i * (60 / projectBPM) * 4;
        const blend = calculateDynamicBlend(i, order.length);
        gainNode.gain.setValueAtTime(blend, startTime);
        source.connect(gainNode);
        gainNode.connect(dryGain);
        gainNode.connect(reverb);
        source.start(startTime);
        activeSources.push({ source, startTime });
    }

    const renderedBuffer = await offlineCtx.startRendering();
    return normalizeBuffer(renderedBuffer);
}

async function createOneShotMix(processedFiles, wetDryMix) {
    if (!processedFiles || processedFiles.length === 0) {
        console.error('app.js: No files provided for one-shot mix');
        return null;
    }
    const sampleRate = audioContext.sampleRate;
    const maxDuration = Math.max(...processedFiles.map(f => f ? f.duration : 0));
    const offlineCtx = new OfflineAudioContext(2, maxDuration * sampleRate, sampleRate);
    const reverb = offlineCtx.createConvolver();
    const reverbBuffer = await createReverbImpulseResponse(offlineCtx, 2.0);
    reverb.buffer = reverbBuffer;
    const dryGain = offlineCtx.createGain();
    const wetGain = offlineCtx.createGain();
    dryGain.gain.value = 1 - wetDryMix;
    wetGain.gain.value = wetDryMix;
    const masterGain = offlineCtx.createGain();
    masterGain.gain.value = 0.8;
    reverb.connect(wetGain);
    wetGain.connect(masterGain);
    dryGain.connect(masterGain);
    masterGain.connect(offlineCtx.destination);

    processedFiles.forEach((buffer, i) => {
        if (!buffer) return;
        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;
        const gainNode = offlineCtx.createGain();
        gainNode.gain.setValueAtTime(0.8, 0);
        source.connect(gainNode);
        gainNode.connect(dryGain);
        gainNode.connect(reverb);
        source.start(0);
        activeSources.push({ source, startTime: 0 });
    });

    const renderedBuffer = await offlineCtx.startRendering();
    return normalizeBuffer(renderedBuffer);
}

function startRealTimeLoop(buffer) {
    if (!buffer || isPlaying) return;
    isPlaying = true;
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(audioContext.destination);
    source.start(0);
    activeSources.push({ source, startTime: audioContext.currentTime });
    loopScheduler = setInterval(() => {
        if (!isPlaying) {
            clearInterval(loopScheduler);
            loopScheduler = null;
            return;
        }
        console.log('app.js: Looping audio');
    }, buffer.duration * 1000);
}

function stopPlayback() {
    console.log('app.js: Stopping playback');
    isPlaying = false;
    
    // Stop all active sources
    activeSources.forEach(({ source }) => {
        try {
            source.stop();
            source.disconnect();
        } catch (e) {
            console.warn('app.js: Error stopping source:', e);
        }
    });
    activeSources = [];
    
    // Clear the scheduler
    if (loopScheduler) {
        clearInterval(loopScheduler);
        loopScheduler = null;
    }
    
    // Don't close the audio context here - just suspend it
    if (audioContext) {
        audioContext.suspend().catch(e => console.warn('app.js: Error suspending audioContext:', e));
    }
}

function restartAudioContext() {
    if (audioContext) {
        // If context exists but is closed, create a new one
        if (audioContext.state === 'closed') {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } 
        // If suspended, resume it
        else if (audioContext.state === 'suspended') {
            audioContext.resume().catch(e => console.warn('app.js: Error resuming audioContext:', e));
        }
    } else {
        // Create new context if none exists
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
}

async function processAudioFiles() {
    console.log('app.js: Processing audio files');
    showStatus('Processing audio...', 'info');
    try {
          restartAudioContext();
        const maxBlend = parseFloat(document.getElementById('max-blend')?.value || 0.5);
        const playbackRate = parseFloat(document.getElementById('playback-rate')?.value || 1.0);
        const preservePitch = document.getElementById('preserve-pitch')?.checked || false;
        const reverbTime = parseFloat(document.getElementById('reverb-time')?.value || 2.0);
        const wetDryMix = parseFloat(document.getElementById('wet-dry')?.value || 0.5);
        const algorithm = document.getElementById('algorithm-select')?.value || 'sequential';
        const silencePercentage = parseFloat(document.getElementById('silence-percentage')?.value || 0);
        const scaleSelect = document.getElementById('scale-select')?.value || 'none';
        const scaleBehavior = document.getElementById('scale-behavior')?.value || 'filter';
        // NEW: Read loop-duration input
        const loopDurationMinutes = Math.max(0.1, Math.min(10, parseFloat(document.getElementById('loop-duration')?.value || 5)));

        console.log('app.js: Processing with settings:', {
            maxBlend, playbackRate, preservePitch, reverbTime, wetDryMix, algorithm, silencePercentage, scaleSelect, scaleBehavior, loopDurationMinutes
        });

        let processedFiles = audioBuffers.filter(b => b);
        if (scaleSelect !== 'none') {
            processedFiles = await adjustToScale(processedFiles, scaleSelect, scaleBehavior);
        }

        if (processedFiles.length === 0) {
            showStatus('No valid audio files to process.', 'error');
            return;
        }

        if (!preservePitch && playbackRate !== 1.0) {
            processedFiles = await Promise.all(processedFiles.map(file => timestretchBuffer(file, playbackRate)));
        }

        let mixedBuffer;
        if (algorithm === 'one-shot') {
            mixedBuffer = await createOneShotMix(processedFiles, wetDryMix);
        } else {
            // NEW: Pass loopDurationMinutes to createLoopingMix
            mixedBuffer = await createLoopingMix(processedFiles, wetDryMix, algorithm, loopDurationMinutes);
        }

        if (!mixedBuffer) {
            showStatus('Failed to mix audio.', 'error');
            return;
        }

        const mixedAudio = document.getElementById('mixed-audio');
        if (mixedAudio) {
            const wavData = encodeWAV(mixedBuffer);
            mixedAudio.src = URL.createObjectURL(new Blob([wavData], { type: 'audio/wav' }));
            mixedAudio.playbackRate = preservePitch ? playbackRate : 1.0;
            mixedAudio.play().catch(e => console.warn('app.js: Error playing mixed audio:', e));
        }

        startRealTimeLoop(mixedBuffer);
        showStatus('Audio processing complete', 'success');
        console.log('app.js: Audio processing complete');
    } catch (error) {
        console.error('app.js: Error processing audio files:', error);
        showStatus(`Error processing audio: ${error.message}`, 'error');
    }
}

function encodeWAV(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length * numChannels * 2 + 44;
    const arrayBuffer = new ArrayBuffer(length);
    const view = new DataView(arrayBuffer);

    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + buffer.length * numChannels * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, buffer.length * numChannels * 2, true);

    const channelData = [];
    for (let c = 0; c < numChannels; c++) {
        channelData.push(buffer.getChannelData(c));
    }

    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
        for (let c = 0; c < numChannels; c++) {
            const sample = Math.max(-1, Math.min(1, channelData[c][i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
            offset += 2;
        }
    }

    return arrayBuffer;
}

function playTestTone() {
    console.log('app.js: Playing test tone');
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(440, audioContext.currentTime);
    oscillator.connect(audioContext.destination);
    oscillator.start();
    setTimeout(() => {
        oscillator.stop();
        oscillator.disconnect();
    }, 1000);
}

function downloadMixedAudio() {
    console.log('app.js: Downloading mixed audio');
    const mixedAudio = document.getElementById('mixed-audio');
    if (!mixedAudio || !mixedAudio.src) {
        showStatus('No mixed audio available to download.', 'error');
        return;
    }
    const a = document.createElement('a');
    a.href = mixedAudio.src;
    a.download = 'mixed_audio.wav';
    a.click();
}

function createFileInputs(count = trackCount) {
    console.log(`Creating ${count} file inputs`);
    const oldInputs = fileInputsContainer.querySelectorAll('.file-upload-input');
    oldInputs.forEach(el => {
        const input = el.querySelector('input[type="file"]');
        if (input) {
            const newInput = input.cloneNode(true);
            input.replaceWith(newInput);
        }
        el.remove();
    });
    audioBuffers = [];
    fileMetadata.clear();
    processingQueue = [];
    isProcessing = false;
    for (let i = 0; i < count; i++) {
        const div = document.createElement('div');
        div.className = 'file-upload-input';
        const label = document.createElement('label');
        label.textContent = `Track ${i + 1}:`;
        label.htmlFor = `file-input-${i}`;
        const input = document.createElement('input');
        input.type = 'file';
        input.id = `file-input-${i}`;
        input.accept = 'audio/*';
        input.disabled = false;
        const fileName = document.createElement('span');
        fileName.className = 'file-name';
        const fileError = document.createElement('span');
        fileError.className = 'file-error';
        const fileBpm = document.createElement('span');
        fileBpm.className = 'file-bpm';
        const waveformCanvas = document.createElement('canvas');
        waveformCanvas.id = `waveform-${i}`;
        waveformCanvas.className = 'file-waveform';
        waveformCanvas.width = 200;
        waveformCanvas.height = 40;
        const loopLabel = document.createElement('label');
        loopLabel.textContent = 'Loop';
        loopLabel.htmlFor = `loop-input-${i}`;
        const loopInput = document.createElement('input');
        loopInput.type = 'checkbox';
        loopInput.id = `loop-input-${i}`;
        loopInput.className = 'loop-checkbox';
        loopInput.addEventListener('change', () => {
            const file = audioBuffers[i]?.name;
            if (file && fileMetadata.has(file)) {
                const metadata = fileMetadata.get(file);
                metadata.isLoop = loopInput.checked;
                fileMetadata.set(file, metadata);
                fileBpm.textContent = `BPM: ${metadata.bpm}, Key: ${metadata.key}, Freq: ${metadata.centerFreq.toFixed(0)}Hz, Type: ${metadata.isLoop ? 'Loop' : 'One-Shot'}`;
                console.log(`app.js: Loop set to ${metadata.isLoop} for ${file}`);
            }
        });
        input.addEventListener('change', () => {
            if (input.files.length > 0) {
                console.log(`app.js: File selected for input ${input.id}: ${input.files[0].name}`);
                fileName.textContent = input.files[0].name;
                processingQueue.push({ file: input.files[0], index: i });
                processQueue();
            } else {
                fileName.textContent = '';
                fileError.textContent = '';
                fileBpm.textContent = '';
                audioBuffers[i] = null;
                updateProcessButtonState();
            }
        });
        div.appendChild(label);
        div.appendChild(input);
        div.appendChild(fileName);
        div.appendChild(fileError);
        div.appendChild(fileBpm);
        div.appendChild(waveformCanvas);
        div.appendChild(loopLabel);
        div.appendChild(loopInput);
        fileInputsContainer.appendChild(div);
    }
}

async function processQueue() {
    if (isProcessing || processingQueue.length === 0) return;
    isProcessing = true;
    showStatus('Processing files...', 'info');
    while (processingQueue.length > 0) {
        const { file, index } = processingQueue.shift();
        await processFile(file, index);
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    isProcessing = false;
    showStatus('File processing complete', 'success');
}

async function distributeFiles(files) {
    try {
        console.log(`app.js: Distributing ${files.length} files`, files.map(f => f.name));
        if (!files || files.length === 0) {
            showStatus('No files provided. Please drag and drop audio files.', 'error');
            return;
        }
        const fileInputs = fileInputsContainer.querySelectorAll('input[type="file"]');
        if (!fileInputs.length) {
            console.error('app.js: No file input elements found in #file-inputs');
            showStatus('No file inputs available. Check UI setup.', 'error');
            return;
        }
        const validFiles = files.filter(file => file.type.startsWith('audio/'));
        if (!validFiles.length) {
            console.error('app.js: No valid audio files in dropped files');
            showStatus(' PaxNo valid audio files detected. Use WAV, MP3, or OGG.', 'error');
            return;
        }
        validFiles.slice(0, fileInputs.length).forEach((file, i) => {
            console.log(`app.js: Queuing ${file.name} for track ${i}`);
            processingQueue.push({ file, index: i });
        });
        processQueue();
        console.log('app.js: File distribution queued');
    } catch (error) {
        console.error('app.js: Error distributing files:', error);
        showStatus(`Error loading files: ${error.message}`, 'error');
    }
}

function setupEventListeners() {
    console.log('app.js: Setting up event listeners');
    try {
        const maxBlendInput = document.getElementById('max-blend');
        const blendValueSpan = document.getElementById('blend-value');
        const playbackRateInput = document.getElementById('playback-rate');
        const playbackRateValue = document.getElementById('playback-rate-value');
        const preservePitchInput = document.getElementById('preserve-pitch');
        const reverbTimeInput = document.getElementById('reverb-time');
        const reverbTimeValue = document.getElementById('reverb-time-value');
        const wetDryInput = document.getElementById('wet-dry');
        const wetDryValue = document.getElementById('wet-dry-value');
        const projectBpmInput = document.getElementById('project-bpm');
        const algorithmSelect = document.getElementById('algorithm-select');
        const silenceInput = document.getElementById('silence-percentage');
        const silenceValue = document.getElementById('silence-value');
        const testToneBtn = document.getElementById('test-tone-btn');
        const downloadBtn = document.getElementById('download-btn');
        const stopBtn = document.getElementById('stop-btn');

        if (trackCountInput) {
            trackCountInput.addEventListener('change', () => {
                const count = Math.max(2, Math.min(10, parseInt(trackCountInput.value) || 5));
                trackCountInput.value = count;
                trackCount = count;
                console.log(`app.js: Track count changed to ${count}`);
                createFileInputs(count);
            });
        }
        if (maxBlendInput && blendValueSpan) {
            maxBlendInput.addEventListener('input', () => {
                blendValueSpan.textContent = `${maxBlendInput.value}%`;
            });
        }
        if (playbackRateInput && playbackRateValue && preservePitchInput) {
            playbackRateInput.addEventListener('input', () => {
                const rate = parseFloat(playbackRateInput.value);
                playbackRateValue.textContent = `${rate.toFixed(2)}x`;
                const mixedAudio = document.getElementById('mixed-audio');
                if (mixedAudio && mixedAudio.src) {
                    mixedAudio.playbackRate = preservePitchInput.checked ? 1 : rate;
                }
            });
        }
        if (reverbTimeInput && reverbTimeValue) {
            reverbTimeInput.addEventListener('input', () => {
                reverbTimeValue.textContent = `${parseFloat(reverbTimeInput.value).toFixed(1)}s`;
            });
        }
        if (wetDryInput && wetDryValue) {
            wetDryInput.addEventListener('input', () => {
                wetDryValue.textContent = `${Math.round(wetDryInput.value * 100)}%`;
            });
        }
        if (projectBpmInput) {
            projectBpmInput.addEventListener('change', () => {
                projectBPM = Math.max(60, Math.min(240, parseInt(projectBpmInput.value) || 120));
                console.log(`app.js: Project BPM set to ${projectBPM}`);
                updateProcessButtonState();
            });
        }
        if (algorithmSelect) {
            algorithmSelect.addEventListener('change', () => {
                console.log(`app.js: Algorithm changed to ${algorithmSelect.value}`);
                updateProcessButtonState();
            });
        }
        if (silenceInput && silenceValue) {
            silenceInput.addEventListener('input', () => {
                silenceValue.textContent = `${silenceInput.value}%`;
            });
        }
        if (processBtn) processBtn.addEventListener('click', processAudioFiles);
        if (testToneBtn) testToneBtn.addEventListener('click', playTestTone);
        if (downloadBtn) downloadBtn.addEventListener('click', downloadMixedAudio);
        if (stopBtn) stopBtn.addEventListener('click', stopPlayback);

        if (!uploadArea) {
            console.error('app.js: .upload-area not found inside #file-inputs');
            showStatus('Upload area not found. Check UI setup.', 'error');
            return;
        }
        console.log('app.js: Binding drag-and-drop to', uploadArea);
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('app.js: Dragover event fired');
            uploadArea.style.background = 'rgba(123, 211, 247, 0.2)';
        }, false);
        uploadArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('app.js: Dragleave event fired');
            uploadArea.style.background = '';
        }, false);
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('app.js: Drop event fired', e.dataTransfer.files);
            uploadArea.style.background = '';
            const files = Array.from(e.dataTransfer.files || []);
            if (!files.length) {
                console.error('app.js: No files in drop event');
                showStatus('No files detected in drop. Try again.', 'error');
                return;
            }
            console.log(`app.js: Dropped ${files.length} files:`, files.map(f => f.name));
            distributeFiles(files);
        }, false);
    } catch (error) {
        console.error('app.js: Error in setupEventListeners:', error);
        showStatus(`Error setting up event listeners: ${error.message}`, 'error');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    createFileInputs();
    setupEventListeners();
});
