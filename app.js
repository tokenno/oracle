console.log("app.js loaded");

window.showStatus = window.showStatus || ((message, type) => console.log(`Status: ${message} (${type})`));

const fileInputsContainer = document.getElementById('file-inputs');
const uploadArea = fileInputsContainer?.querySelector('.upload-area');
const trackCountInput = document.getElementById('track-count');
const processBtn = document.getElementById('process-btn');
let trackCount = parseInt(trackCountInput?.value) || 5;
let isAutoLoading = false;

if (!fileInputsContainer || !uploadArea || !trackCountInput || !processBtn) {
    console.error('Required elements missing:', { fileInputsContainer, uploadArea, trackCountInput, processBtn });
    window.showStatus('UI elements not found. Check console.', 'error');
    throw new Error('Initialization failed');
}
let loopDurationMinutes = 1.0;
let loopAllCheckbox = document.getElementById('loop-all-checkbox');
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
    // Traditional scales
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
    melodicMinor: [0, 2, 3, 5, 7, 9, 11],
    pentatonic: [0, 2, 4, 7, 9],
    blues: [0, 3, 5, 6, 7, 10],
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    
    // Exotic/experimental scales
    twelveToneRow: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // Serialism
    ligeti: [0, 1, 3, 4, 6, 7, 9, 10], // Micropolyphony clusters
    wholeTone: [0, 2, 4, 6, 8, 10], // Dreamlike quality
    octatonic: [0, 2, 3, 5, 6, 8, 9, 11], // Diminished scale
    messiaen3: [0, 2, 3, 6, 7, 8, 10, 11], // Mode of limited transposition
    pelog: [0, 1, 3, 7, 8], // Balinese gamelan
    slendro: [0, 3, 5, 7, 10], // Javanese equal temperament
    partch43: [0, 6, 14, 20, 28, 34, 42], // Microtonal just intonation
    hexany: [0, 6, 14, 20], // 6-note Partch subset
    alpha: [0, 15, 30, 45, 60, 75, 90, 105, 120], // Wendy Carlos' 15.4¢ steps
    
    // Additional interesting scales
    hungarianMinor: [0, 2, 3, 6, 7, 8, 11],
    enigmatic: [0, 1, 4, 6, 8, 10, 11],
    arabic: [0, 1, 4, 5, 7, 8, 11],
    hirajoshi: [0, 2, 3, 7, 8],
    iwato: [0, 1, 5, 6, 10],
    prometheus: [0, 2, 4, 6, 9, 10],
    scriabin: [0, 1, 4, 7, 9], // Mystic chord
    bartok: [0, 2, 4, 6, 7, 9, 10],
    persian: [0, 1, 4, 5, 6, 8, 11],
    byzantine: [0, 1, 4, 5, 7, 8, 11],
    japanese: [0, 1, 5, 7, 8],
    balinese: [0, 1, 3, 7, 8],
    egyptian: [0, 2, 5, 7, 10],
    hawaiian: [0, 2, 3, 5, 7, 9, 10],
    romanian: [0, 2, 3, 6, 7, 9, 10],
    spanish8Tone: [0, 1, 3, 4, 5, 6, 8, 10],
    bebopDominant: [0, 2, 4, 5, 7, 9, 10, 11],
    bebopMajor: [0, 2, 4, 5, 7, 8, 9, 11],
    bluesOctave: [0, 3, 5, 6, 7, 10, 12],
    doubleHarmonic: [0, 1, 4, 5, 7, 8, 11],
    neapolitanMajor: [0, 1, 3, 5, 7, 9, 11],
    neapolitanMinor: [0, 1, 3, 5, 7, 8, 11],
    overtone: [0, 2, 4, 6, 7, 9, 10],
    altered: [0, 1, 3, 4, 6, 8, 10],
    locrianMajor: [0, 2, 4, 5, 6, 8, 10],
    lydianAugmented: [0, 2, 4, 6, 8, 9, 11],
    lydianDominant: [0, 2, 4, 6, 7, 9, 10],
    superLocrian: [0, 1, 3, 4, 6, 8, 10],
    ultralocrian: [0, 1, 3, 4, 6, 7, 9, 10]
};

function showStatus(message, type) {
    const statusDisplay = document.getElementById('status-display');
    if (statusDisplay) {
        statusDisplay.innerHTML = `<div class="status-message ${type}">${message}</div>`;
        statusDisplay.style.display = 'block';
        setTimeout(() => statusDisplay.style.display = 'none', 3000);
    }
    console.log(`Status: ${message} (${type})`);
}

async function adjustToScale(files, scaleName, behavior) {
    if (scaleName === 'none' || !SCALES[scaleName]) return files;
    
    const scale = SCALES[scaleName];
    const results = [];
    
    for (const file of files) {
        try {
            if (!file) {
                results.push(null);
                continue;
            }

            const metadata = fileMetadata.get(file.name);
            if (!metadata) {
                results.push(behavior === 'filter' ? null : file);
                continue;
            }

            let key = metadata.key;
            if (!key || key === 'Unknown') key = extractKeyFromFilename(file.name);
            if (!key || key === 'Unknown') {
                results.push(behavior === 'filter' ? null : file);
                continue;
            }

            const rootNote = noteToMidi(key.split(' ')[0]);
            if (rootNote === null) {
                results.push(behavior === 'filter' ? null : file);
                continue;
            }

            const fileNote = rootNote % 12;
            
            if (behavior === 'filter') {
                if (scale.includes(fileNote)) results.push(file);
                else results.push(null);
            } 
            else if (behavior === 'transpose') {
                const nearestNote = findNearestScaleNote(fileNote, scale);
                const transposeAmount = nearestNote - fileNote;
                
                if (transposeAmount !== 0) {
                    // Get the audio buffer first
                    let buffer;
                    if (file instanceof AudioBuffer) {
                        buffer = file;
                    } else {
                        const arrayBuffer = await file.arrayBuffer();
                        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                        buffer = await audioCtx.decodeAudioData(arrayBuffer);
                    }
                    
                    const transposedBuffer = await transposeBuffer(buffer, transposeAmount);
                    transposedBuffer.name = file.name; // Preserve filename
                    results.push(transposedBuffer);
                } else {
                    results.push(file);
                }
            }
            else { // reorder
                results.push(file);
            }
        } catch (error) {
            console.error(`Error processing file ${file?.name}:`, error);
            results.push(null);
        }
    }

    return behavior === 'reorder' ? 
        reorderFilesByScale(results.filter(Boolean), scale) : 
        results.filter(file => file !== null);
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

function reorderFilesByScale(files, scale) {
    return files
        .map((file, index) => {
            const metadata = fileMetadata.get(file.name);
            let key = metadata?.key || extractKeyFromFilename(file.name);
            if (!key || key === 'Unknown') key = 'C';
            const rootNote = noteToMidi(key.split(' ')[0]);
            return {
                file,
                rootNote: rootNote !== null ? rootNote % 12 : 0,
                index
            };
        })
        .sort((a, b) => {
            const aInScale = scale.includes(a.rootNote);
            const bInScale = scale.includes(b.rootNote);
            if (aInScale && !bInScale) return -1;
            if (!aInScale && bInScale) return 1;
            return a.rootNote - b.rootNote;
        })
        .map(item => item.file);
}

// Ensure noteToMidi handles edge cases
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

function validateAudioBuffer(buffer, fileName) {
    if (!buffer) {
        console.warn(`Invalid buffer for ${fileName}: null or undefined`);
        return false;
    }
    if (buffer.duration <= 0 || isNaN(buffer.duration)) {
        console.warn(`Invalid duration for ${fileName}: ${buffer.duration}`);
        return false;
    }
    if (!buffer.sampleRate || buffer.sampleRate <= 0) {
        console.warn(`Invalid sample rate for ${fileName}: ${buffer.sampleRate}`);
        return false;
    }
    if (!buffer.numberOfChannels) {
        console.warn(`Invalid channels for ${fileName}: ${buffer.numberOfChannels}`);
        return false;
    }
    console.log(`Buffer validated for ${fileName}: duration=${buffer.duration}s, sampleRate=${buffer.sampleRate}, channels=${buffer.numberOfChannels}`);
    return true;
}

function updateProcessButtonState() {
    const fileInputs = fileInputsContainer.querySelectorAll('input[type="file"]:not(#folder-input)');
    let validBuffers = 0;
    audioBuffers.forEach((buffer, i) => {
        if (buffer && validateAudioBuffer(buffer, buffer.name)) {
            validBuffers++;
            if (fileInputs[i]) {
                fileInputs[i].classList.remove('invalid');
                fileInputs[i].classList.add('valid');
            }
        } else {
            if (fileInputs[i]) {
                fileInputs[i].classList.remove('valid');
                fileInputs[i].classList.add('invalid');
            }
        }
    });
    processBtn.disabled = validBuffers === 0;
    console.log(`app.js: updateProcessButtonState - Valid buffers: ${validBuffers}, Track count: ${trackCount}, Button disabled: ${processBtn.disabled}, audioBuffers:`, audioBuffers.map(b => b ? b.name : null));
    if (validBuffers === 0) {
        showStatus('No valid audio files loaded. Check file formats or console for errors.', 'error');
    } else {
        showStatus(`${validBuffers} valid audio file(s) loaded.`, 'info');
        if (isAutoLoading && validBuffers > 0) {
            console.log('app.js: Auto-triggering processAudioFiles');
            processAudioFiles();
            isAutoLoading = false;
        }
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
        if (file.size > 50 * 1024 * 1024) {
            throw new Error('File too large. Limit is 50MB.');
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
            console.warn(`Decode error for ${file.name}:`, decodeError);
            fileErrorSpan.textContent = `Decode error: ${decodeError.message}`;
            throw new Error(`Failed to decode audio: ${decodeError.message}`);
        }
        if (!validateAudioBuffer(audioBuffer, file.name)) {
            fileErrorSpan.textContent = 'Invalid audio buffer';
            throw new Error('Invalid audio buffer: corrupted or empty audio data.');
        }
        audioBuffer.name = file.name;
        audioBuffers[index] = audioBuffer;

        let metadata = { bpm: 120, key: 'Unknown', isLoop: loopInput.checked, centerFreq: 0 };
        try {
            metadata.key = extractKeyFromFilename(file.name);
            metadata.bpm = await detectBPM(file, true);
            metadata.centerFreq = await getFFTCenterFrequency(audioBuffer, 30);
            console.log(`Metadata for ${file.name}: BPM=${metadata.bpm}, Key=${metadata.key}, Freq=${metadata.centerFreq.toFixed(1)}Hz`);
        } catch (metaError) {
            console.warn(`Metadata error for ${file.name}:`, metaError);
        }
        fileMetadata.set(file.name, metadata);
        fileBpmSpan.textContent = `BPM: ${metadata.bpm}, Key: ${metadata.key}, Freq: ${metadata.centerFreq.toFixed(0)}Hz, Type: ${metadata.isLoop ? 'Loop' : 'One-Shot'}`;
        drawWaveformPerFile(audioBuffer, index);
        console.log(`app.js: Processed ${file.name} in ${(performance.now() - startTime).toFixed(2)}ms`);
    } catch (error) {
        console.error(`Error processing file ${file.name}:`, error);
        fileErrorSpan.textContent = `Error: ${error.message}`;
        audioBuffers[index] = null;
    } finally {
        updateProcessButtonState();
    }
}

async function detectBPM(file, optimize = false) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        
        // Use first channel only for analysis
        const channelData = audioBuffer.getChannelData(0); 
        const sampleRate = audioBuffer.sampleRate;
        
        // Analyze different sections if not optimized
        const analysisDuration = optimize ? Math.min(30, audioBuffer.duration) : audioBuffer.duration;
        const maxSamples = Math.min(channelData.length, sampleRate * analysisDuration);
        
        // Better downsampling with anti-aliasing
        const targetSampleRate = 11025; // Good balance for tempo analysis
        const downsampledData = downsampleBuffer(channelData, sampleRate, targetSampleRate, maxSamples);
        
        // Apply multiple detection methods
        const bpmCandidates = [
            ...findBPMCandidatesWithAutocorrelation(downsampledData, targetSampleRate),
            ...findBPMCandidatesWithBeatTracking(downsampledData, targetSampleRate),
            ...findBPMCandidatesWithOnsetDetection(downsampledData, targetSampleRate)
        ];
        
        // Validate candidates and return best match
        return selectBestBPM(bpmCandidates);
    } catch (error) {
        console.error('BPM detection error:', error);
        return 120; // Fallback BPM
    }
}

// Enhanced detection methods
function findBPMCandidatesWithAutocorrelation(data, sampleRate) {
    const minBPM = 40;  // Extended range for very slow tempos
    const maxBPM = 300; // Extended range for very fast tempos
    const candidates = [];
    
    // Apply high-pass filter to remove DC offset
    const filteredData = highPassFilter(data, sampleRate, 50);
    
    // Analyze multiple window sizes with overlap
    const windowSizes = [3, 6, 12]; // in seconds
    const hopSize = 0.5; // 50% overlap between windows
    
    windowSizes.forEach(windowSize => {
        const windowSamples = Math.floor(windowSize * sampleRate);
        const hopSamples = Math.floor(hopSize * sampleRate);
        const steps = Math.floor((data.length - windowSamples) / hopSamples);
        
        for (let step = 0; step < steps; step++) {
            const start = step * hopSamples;
            const end = Math.min(start + windowSamples, data.length);
            const window = filteredData.slice(start, end);
            
            const autocorr = calculateWeightedAutocorrelation(window);
            const peaks = findSignificantPeaks(autocorr, sampleRate, minBPM, maxBPM);
            
            peaks.forEach(peak => {
                const bpm = 60 / (peak.position / sampleRate);
                if (bpm >= minBPM && bpm <= maxBPM) {
                    candidates.push({
                        bpm: Math.round(bpm),
                        strength: peak.strength * (1 - 0.1 * windowSize), // Smaller windows get slightly more weight
                        method: 'autocorr',
                        windowSize
                    });
                }
            });
        }
    });
    
    return candidates;
}

function findBPMCandidatesWithBeatTracking(data, sampleRate) {
    const candidates = [];
    const minBPM = 100; // Focus on faster tempos
    const maxBPM = 300;
    
    // Calculate spectral flux (good for detecting beats)
    const frameSize = 1024;
    const hopSize = frameSize / 4;
    const frames = Math.floor(data.length / hopSize) - 1;
    const spectralFlux = new Float32Array(frames);
    
    let prevSpectrum = new Float32Array(frameSize / 2);
    for (let i = 0; i < frames; i++) {
        const start = i * hopSize;
        const frame = data.slice(start, start + frameSize);
        const spectrum = calculateFFT(frame);
        
        // Calculate spectral flux
        let flux = 0;
        for (let j = 0; j < spectrum.length; j++) {
            const diff = spectrum[j] - prevSpectrum[j];
            flux += diff > 0 ? diff : 0;
        }
        spectralFlux[i] = flux;
        prevSpectrum = spectrum;
    }
    
    // Find peaks in spectral flux (potential beats)
    const peaks = findPeaks(spectralFlux, 0.5);
    if (peaks.length < 2) return candidates;
    
    // Calculate inter-beat intervals
    const ibis = [];
    for (let i = 1; i < peaks.length; i++) {
        ibis.push((peaks[i] - peaks[i-1]) * hopSize / sampleRate);
    }
    
    // Calculate BPM from intervals
    const bpmValues = ibis.map(ibi => 60 / ibi);
    const validBpms = bpmValues.filter(bpm => bpm >= minBPM && bpm <= maxBPM);
    
    // Group similar BPMs
    const groups = {};
    validBpms.forEach(bpm => {
        const rounded = Math.round(bpm / 5) * 5;
        groups[rounded] = (groups[rounded] || 0) + 1;
    });
    
    // Add top candidates
    Object.entries(groups)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .forEach(([bpm, count]) => {
            candidates.push({
                bpm: parseInt(bpm),
                strength: count / peaks.length,
                method: 'beat'
            });
        });
    
    return candidates;
}

function findBPMCandidatesWithOnsetDetection(data, sampleRate) {
    const candidates = [];
    const minBPM = 30; // Focus on slower tempos
    const maxBPM = 100;
    
    // Calculate energy envelope
    const frameSize = 2048;
    const hopSize = frameSize / 2;
    const frames = Math.floor(data.length / hopSize);
    const envelope = new Float32Array(frames);
    
    for (let i = 0; i < frames; i++) {
        const start = i * hopSize;
        const frame = data.slice(start, start + frameSize);
        envelope[i] = frame.reduce((sum, x) => sum + x * x, 0) / frame.length;
    }
    
    // Find onsets (sudden increases in energy)
    const onsets = [];
    const threshold = 0.1 * Math.max(...envelope); // Dynamic threshold
    for (let i = 1; i < envelope.length; i++) {
        if (envelope[i] - envelope[i-1] > threshold) {
            onsets.push(i);
        }
    }
    
    if (onsets.length < 2) return candidates;
    
    // Calculate inter-onset intervals
    const iois = [];
    for (let i = 1; i < onsets.length; i++) {
        iois.push((onsets[i] - onsets[i-1]) * hopSize / sampleRate);
    }
    
    // Calculate BPM from intervals
    const bpmValues = iois.map(ioi => 60 / ioi);
    const validBpms = bpmValues.filter(bpm => bpm >= minBPM && bpm <= maxBPM);
    
    // Group similar BPMs
    const groups = {};
    validBpms.forEach(bpm => {
        const rounded = Math.round(bpm / 5) * 5;
        groups[rounded] = (groups[rounded] || 0) + 1;
    });
    
    // Add top candidates
    Object.entries(groups)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .forEach(([bpm, count]) => {
            candidates.push({
                bpm: parseInt(bpm),
                strength: count / onsets.length,
                method: 'onset'
            });
        });
    
    return candidates;
}

// Enhanced version of selectBestBPM
function selectBestBPM(candidates) {
    if (candidates.length === 0) return 120;
    
    // Group similar BPM values (±5 BPM)
    const groups = {};
    candidates.forEach(candidate => {
        const key = Math.round(candidate.bpm / 5) * 5;
        groups[key] = groups[key] || [];
        groups[key].push(candidate);
    });
    
    // Find strongest group considering method reliability
    let bestGroup = null;
    let maxStrength = 0;
    Object.entries(groups).forEach(([key, group]) => {
        // Weight different methods differently
        const groupStrength = group.reduce((sum, c) => {
            let weight = 1.0;
            if (c.method === 'autocorr') weight = 1.2; // Most reliable
            if (c.method === 'beat') weight = 1.0;
            if (c.method === 'onset') weight = 0.8; // Least reliable
            return sum + (c.strength * weight);
        }, 0);
        
        if (groupStrength > maxStrength) {
            maxStrength = groupStrength;
            bestGroup = group;
        }
    });
    
    // Return median of best group
    const sortedBPMs = bestGroup.map(c => c.bpm).sort((a, b) => a - b);
    const medianBpm = sortedBPMs[Math.floor(sortedBPMs.length / 2)];
    
    // Special handling for very fast/slow tempos
    if (medianBpm > 200) {
        // Check if this might be a double-time tempo
        const halfBpm = medianBpm / 2;
        const hasHalfBpm = candidates.some(c => Math.abs(c.bpm - halfBpm) < 5);
        return hasHalfBpm ? halfBpm : medianBpm;
    } else if (medianBpm < 50) {
        // Check if this might be a half-time tempo
        const doubleBpm = medianBpm * 2;
        const hasDoubleBpm = candidates.some(c => Math.abs(c.bpm - doubleBpm) < 5);
        return hasDoubleBpm ? doubleBpm : medianBpm;
    }
    
    return medianBpm;
}



async function getFFTCenterFrequency(buffer, maxSeconds = Infinity) {
    if (!buffer || buffer.numberOfChannels === 0) return 0;
    
    const fftSize = 2048; // Keep consistent with your original size
    const maxSamples = Math.min(buffer.length, buffer.sampleRate * maxSeconds);
    const offlineCtx = new OfflineAudioContext(1, maxSamples, buffer.sampleRate);
    
    // Create analyzer with larger FFT for better frequency resolution
    const analyser = offlineCtx.createAnalyser();
    analyser.fftSize = fftSize;
    const binCount = analyser.frequencyBinCount;
    const binWidth = offlineCtx.sampleRate / fftSize;

    // Prepare audio buffer
    const source = offlineCtx.createBufferSource();
    const tempBuffer = offlineCtx.createBuffer(buffer.numberOfChannels, maxSamples, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
        tempBuffer.copyToChannel(buffer.getChannelData(c).slice(0, maxSamples), c);
    }
    source.buffer = tempBuffer;
    source.connect(analyser);
    analyser.connect(offlineCtx.destination);
    source.start(0);

    // Process audio
    await offlineCtx.startRendering();
    
    // Get frequency data
    const dataArray = new Float32Array(binCount);
    analyser.getFloatFrequencyData(dataArray);

    // Calculate weighted spectral centroid with A-weighting approximation
    let totalMagnitude = 0;
    let weightedSum = 0;
    
    for (let i = 0; i < binCount; i++) {
        const freq = i * binWidth;
        const magnitude = Math.pow(10, dataArray[i] / 20); // Convert dB to linear
        
        // Apply simple A-weighting approximation (emphasizes mid frequencies)
        const aWeighting = freq < 1000 ? 
            Math.min(1, freq / 1000) : // Roll off lows
            Math.min(1, 4000 / freq);  // Roll off highs
        
        const weightedMagnitude = magnitude * aWeighting;
        
        totalMagnitude += weightedMagnitude;
        weightedSum += freq * weightedMagnitude;
    }

    // Also find peak frequency (useful for musical analysis)
    let peakMag = 0;
    let peakFreq = 0;
    for (let i = 0; i < binCount; i++) {
        const freq = i * binWidth;
        const magnitude = Math.pow(10, dataArray[i] / 20);
        if (magnitude > peakMag) {
            peakMag = magnitude;
            peakFreq = freq;
        }
    }

    // Return weighted average, but bias slightly toward peak frequency
    const centroid = totalMagnitude > 0 ? weightedSum / totalMagnitude : 0;
    return (centroid * 0.7 + peakFreq * 0.3); // Blend of centroid and peak
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
        if (data[i] > data[i - 1] && data[i] > data[i + 1]) {
            peaks.push(i);
        }
    }
    return peaks.sort((a, b) => data[b] - data[a]);
}

async function transposeBuffer(fileOrBuffer, semitones) {
    try {
        // Handle both File objects and AudioBuffer objects
        let arrayBuffer;
        if (fileOrBuffer instanceof File || fileOrBuffer instanceof Blob) {
            arrayBuffer = await fileOrBuffer.arrayBuffer();
        } else if (fileOrBuffer instanceof ArrayBuffer) {
            arrayBuffer = fileOrBuffer;
        } else {
            throw new Error('Invalid input type for transposition');
        }

        const offlineCtx = new OfflineAudioContext(2, arrayBuffer.byteLength, 44100);
        const buffer = await offlineCtx.decodeAudioData(arrayBuffer);
        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = Math.pow(2, semitones / 12);
        source.connect(offlineCtx.destination);
        source.start(0);
        const renderedBuffer = await offlineCtx.startRendering();
        return renderedBuffer;
    } catch (error) {
        console.error('Error in transposeBuffer:', error);
        throw error;
    }
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
    if (!canvas) return;
    
    // Mobile-responsive sizing
    const isMobile = window.matchMedia("(max-width: 768px)").matches;
    const size = isMobile ? 120 : 150;
    canvas.width = size;
    canvas.height = size;
    
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Center calculations
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const maxRadius = (Math.min(canvas.width, canvas.height) / 2) * 0.9;
    
    // Create circular clipping path
    ctx.beginPath();
    ctx.arc(centerX, centerY, maxRadius, 0, Math.PI * 2);
    ctx.clip();
    
    // Draw background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    if (!buffer) return;
    
    // Draw waveform
    const channelData = buffer.getChannelData(0);
    ctx.strokeStyle = '#7bd3f7';
    ctx.lineWidth = isMobile ? 1 : 1.5;
    ctx.beginPath();
    
    for (let i = 0; i < 360; i++) {
        const angle = (i * Math.PI) / 180;
        const sampleIndex = Math.floor((i / 360) * channelData.length);
        const sample = channelData[sampleIndex] || 0;
        const radius = maxRadius * (1 + sample * 0.7);
        
        const x = centerX + Math.cos(angle) * radius;
        const y = centerY + Math.sin(angle) * radius;
        
        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }
    
    ctx.closePath();
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
        const scaleName = document.getElementById('musical-scale')?.value || 'none';
        const scale = SCALES[scaleName] || SCALES.chromatic;
        const sortedIndices = files.map((file, index) => {
            const metadata = fileMetadata.get(file.name);
            let key = metadata?.key || extractKeyFromFilename(file.name);
            if (!key || key === 'Unknown') key = 'C';
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
    } else if (algorithm === 'freq-asc') {
        const sortedIndices = files.map((file, index) => {
            const metadata = fileMetadata.get(file.name);
            return { index, centerFreq: metadata?.centerFreq || 0 };
        }).sort((a, b) => a.centerFreq - b.centerFreq).map(item => item.index);
        for (let i = 0; i < length; i++) {
            order.push(sortedIndices[i % sortedIndices.length]);
        }
    } else if (algorithm === 'freq-desc') {
        const sortedIndices = files.map((file, index) => {
            const metadata = fileMetadata.get(file.name);
            return { index, centerFreq: metadata?.centerFreq || 0 };
        }).sort((a, b) => b.centerFreq - a.centerFreq).map(item => item.index);
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

function validateAudioProcessing(files, channels, length, sampleRate, contextName = 'unknown') {
    // Validate context parameters
    if (!Number.isFinite(channels) || channels < 1) {
        throw new Error(`Invalid number of channels for ${contextName}: ${channels}`);
    }
    if (!Number.isFinite(length) || length <= 0) {
        throw new Error(`Invalid length for ${contextName}: ${length}`);
    }
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
        throw new Error(`Invalid sample rate for ${contextName}: ${sampleRate}`);
    }

    // Validate and filter audio buffers
    if (!files || files.length === 0) {
        throw new Error(`No audio files provided for ${contextName}`);
    }
    const validFiles = files.filter(f => {
        if (!f || !(f instanceof AudioBuffer)) {
            console.warn(`Invalid or null AudioBuffer for ${f?.name || 'unknown'}`);
            return false;
        }
        if (f.duration <= 0 || isNaN(f.duration)) {
            console.warn(`Invalid duration for ${f.name}: ${f.duration}`);
            return false;
        }
        if (!f.sampleRate || f.sampleRate <= 0) {
            console.warn(`Invalid sample rate for ${f.name}: ${f.sampleRate}`);
            return false;
        }
        if (!f.numberOfChannels || f.numberOfChannels < 1) {
            console.warn(`Invalid number of channels for ${f.name}: ${f.numberOfChannels}`);
            return false;
        }
        return true;
    });

    if (validFiles.length === 0) {
        throw new Error(`No valid audio buffers for ${contextName}`);
    }

    return validFiles;
}

async function createLoopingMix(processedFiles, wetDryMix, algorithm, loopDurationMinutes) {
    if (!processedFiles || processedFiles.length === 0) {
        console.error('app.js: No files provided for looping mix');
        window.showStatus('No valid audio files for mixing.', 'error');
        return null;
    }

    try {
        const sampleRate = audioContext.sampleRate;
        const loopDurationSeconds = loopDurationMinutes * 60;
        const beatDuration = (60 / projectBPM) * 4;
        const maxLoops = Math.min(MAX_LOOPS, Math.ceil(loopDurationSeconds / beatDuration));
        const maxDuration = Math.min(600, Math.max(...processedFiles.map(f => f ? f.duration : 0)) * maxLoops);

        // Validate files and context parameters
        const validFiles = validateAudioProcessing(processedFiles, 2, maxDuration * sampleRate, sampleRate, 'looping mix');

        const offlineCtx = new OfflineAudioContext(2, Math.max(1, maxDuration * sampleRate), sampleRate);
        const reverb = offlineCtx.createConvolver();
        const reverbBuffer = await createReverbImpulseResponse(offlineCtx, 2.0);
        validateAudioProcessing([reverbBuffer], 2, reverbBuffer.length, reverbBuffer.sampleRate, 'reverb impulse');
        reverb.buffer = reverbBuffer;
        const dryGain = offlineCtx.createGain();
        const wetGain = offlineCtx.createGain();
        dryGain.gain.value = 1 - wetDryMix;
        wetGain.gain.value = wetDryMix;
        const masterGain = offlineCtx.createGain();
        const masterGainValue = Math.min(0.8 / Math.sqrt(validFiles.length), 0.8);
        masterGain.gain.value = masterGainValue;
        reverb.connect(wetGain);
        wetGain.connect(masterGain);
        dryGain.connect(masterGain);
        masterGain.connect(offlineCtx.destination);

        let order = [];
        if (algorithm === 'sequential') {
            order = Array.from({ length: maxLoops }, (_, i) => i % validFiles.length);
        } else if (algorithm === 'markov') {
            if (!markovChain) markovChain = buildMarkovChain(validFiles);
            order = generateMarkovOrder(markovChain, maxLoops);
        } else {
            order = getAlgorithmicOrder(validFiles, algorithm, maxLoops);
        }

        for (let i = 0; i < order.length; i++) {
            const fileIndex = order[i];
            const buffer = validFiles[fileIndex];
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
        validateAudioProcessing([renderedBuffer], 2, renderedBuffer.length, renderedBuffer.sampleRate, 'rendered looping mix');
        return normalizeBuffer(renderedBuffer);
    } catch (error) {
        console.error('app.js: Error in createLoopingMix:', error);
        window.showStatus(`Failed to create looping mix: ${error.message}`, 'error');
        return null;
    }
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
    activeSources.forEach(({ source }) => {
        try {
            source.stop();
            source.disconnect();
        } catch (e) {
            console.warn('app.js: Error stopping source:', e);
        }
    });
    activeSources = [];
    if (loopScheduler) {
        clearInterval(loopScheduler);
        loopScheduler = null;
    }
    if (audioContext) {
        audioContext.suspend().catch(e => console.warn('app.js: Error suspending audioContext:', e));
    }
 // Also stop the blinking when audio stops
    stopNodeBlinking();
}

function restartAudioContext() {
    if (audioContext) {
        if (audioContext.state === 'closed') {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } else if (audioContext.state === 'suspended') {
            audioContext.resume().catch(e => console.warn('app.js: Error resuming audioContext:', e));
        }
    } else {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
}

// In your processAudioFiles function, modify it like this:

async function processAudioFiles() {
    console.log('app.js: Processing audio files');
    const statusDisplay = document.getElementById('status-display');
    const downloadBtn = document.getElementById('download-btn');
    
    try {
        statusDisplay.innerHTML = '<div class="status-message info">Processing audio... Please wait</div>';
        statusDisplay.style.display = 'block';
        statusDisplay.style.opacity = '1';
        if (downloadBtn) downloadBtn.disabled = true;

        restartAudioContext();
        const maxBlend = parseFloat(document.getElementById('max-blend')?.value || 0.5);
        const playbackRate = parseFloat(document.getElementById('playback-rate')?.value || 1.0);
        const preservePitch = document.getElementById('preserve-pitch')?.checked || false;
        const reverbTime = parseFloat(document.getElementById('reverb-time')?.value || 2.0);
        const wetDryMix = parseFloat(document.getElementById('wet-dry')?.value || 0.5);
        const algorithm = document.getElementById('algorithm-select')?.value || 'sequential';
        const silencePercentage = parseFloat(document.getElementById('silence-percentage')?.value || 0);
        const scaleSelect = document.getElementById('musical-scale')?.value || 'none';
        const scaleBehavior = document.getElementById('scale-behavior')?.value || 'filter';
        const loopDurationMinutes = Math.max(0.1, Math.min(10, parseFloat(document.getElementById('loop-duration')?.value || 1.0)));

        let processedFiles = audioBuffers.filter(b => b && validateAudioBuffer(b, b.name));
        if (processedFiles.length === 0) {
            showStatus('No valid audio files to process.', 'error');
            if (downloadBtn) downloadBtn.disabled = true;
            return;
        }

        if (scaleSelect !== 'none') {
            processedFiles = await adjustToScale(processedFiles, scaleSelect, scaleBehavior);
        }

        if (!preservePitch && playbackRate !== 1.0) {
            processedFiles = await Promise.all(processedFiles.map(file => timestretchBuffer(file, playbackRate)));
        }

        let mixedBuffer;
        if (algorithm === 'one-shot') {
            mixedBuffer = await createOneShotMix(processedFiles, wetDryMix);
        } else {
            mixedBuffer = await createLoopingMix(processedFiles, wetDryMix, algorithm, loopDurationMinutes);
        }

        if (!mixedBuffer || !validateAudioBuffer(mixedBuffer, 'mixed-audio')) {
            showStatus('Failed to mix audio: invalid output buffer.', 'error');
            if (downloadBtn) downloadBtn.disabled = true;
            return;
        }

        const mixedAudio = document.getElementById('mixed-audio');
        if (mixedAudio) {
            const wavData = encodeWAV(mixedBuffer);
            const audioBlob = new Blob([wavData], { type: 'audio/wav' });
            mixedAudio.src = URL.createObjectURL(audioBlob);
            mixedAudio.playbackRate = preservePitch ? playbackRate : 1.0;
            
            if (downloadBtn) {
                downloadBtn.disabled = false;
                console.log('Download button enabled');
            }

            if (mixedAudio._previousBlobUrl) {
                URL.revokeObjectURL(mixedAudio._previousBlobUrl);
            }
            mixedAudio._previousBlobUrl = mixedAudio.src;

  mixedAudio.onplay = () => {
    statusDisplay.style.opacity = '0';
    setTimeout(() => {
        statusDisplay.style.display = 'none';
        startTempoSyncedBlinking(); // Use the new function
    }, 500);
};
            mixedAudio.play().catch(e => {
                console.warn('app.js: Error playing mixed audio:', e);
                showStatus('Error playing audio. Click play manually.', 'error');
            });
        }

        startRealTimeLoop(mixedBuffer);
    } catch (error) {
        console.error('app.js: Error processing audio files:', error);
        let errorMessage = error.message;
        if (error.message.includes('non-finite') || error.message.includes('timing')) {
            errorMessage = 'Invalid timing parameters. Please check: \n' +
                          '- BPM should be between 40-240 \n' +
                          '- Loop duration should be 0.1-10 minutes \n' +
                          '- Playback rate should be between 0.1-4.0';
        }
        
        showStatus(`Error: ${errorMessage}`, 'error');
        if (downloadBtn) downloadBtn.disabled = true;
        
        const mixedAudio = document.getElementById('mixed-audio');
        if (mixedAudio && mixedAudio.src) {
            URL.revokeObjectURL(mixedAudio.src);
            mixedAudio.removeAttribute('src');
        }
    }
}

// Modify your showStatus function to not auto-hide for processing messages:
function showStatus(message, type) {
    const statusDisplay = document.getElementById('status-display');
    if (statusDisplay) {
        statusDisplay.innerHTML = `<div class="status-message ${type}">${message}</div>`;
        statusDisplay.style.display = 'block';
        statusDisplay.style.opacity = '1';
        
        // Only auto-hide if it's not a processing message
        if (!message.includes('Processing') && !message.includes('Please wait')) {
            setTimeout(() => {
                statusDisplay.style.opacity = '0';
                setTimeout(() => {
                    statusDisplay.style.display = 'none';
                }, 500); // Match the CSS transition duration
            }, 3000);
        }
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

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function createFileInputs(count = trackCount) {
      console.log(`Creating ${count} file inputs`);
    const oldInputs = fileInputsContainer.querySelectorAll('.file-upload-input');
    oldInputs.forEach(el => el.remove());
    audioBuffers = new Array(count).fill(null);
    fileMetadata.clear();
    processingQueue = [];
    isProcessing = false;

        loopAllCheckbox = document.getElementById('loop-all-checkbox');
    if (loopAllCheckbox) {
        loopAllCheckbox.addEventListener('change', function() {
            const shouldLoop = this.checked;
            document.querySelectorAll('.loop-checkbox').forEach(checkbox => {
                checkbox.checked = shouldLoop;
                // Trigger change event to update metadata
                const event = new Event('change');
                checkbox.dispatchEvent(event);
            });
            showStatus(shouldLoop ? 'All files set to loop' : 'Looping disabled for all files', 'info');
        });
    }

    const folderInputDiv = document.createElement('div');
    folderInputDiv.className = 'file-upload-input';
    folderInputDiv.style.display = 'none';
    const folderInput = document.createElement('input');
    folderInput.type = 'file';
    folderInput.id = 'folder-input';
    folderInput.setAttribute('webkitdirectory', '');
    folderInput.setAttribute('directory', '');
    folderInput.accept = 'audio/*';
    folderInput.addEventListener('change', () => {
        console.log(`Folder input changed, files: ${folderInput.files.length}`);
        if (folderInput.files.length > 0) {
            console.log(`app.js: Folder selected with ${folderInput.files.length} files`);
            showStatus(`Selected folder with ${folderInput.files.length} audio files`, 'info');
            isAutoLoading = true;
            distributeFiles(Array.from(folderInput.files));
        } else {
            showStatus('No files selected from folder.', 'info');
            isAutoLoading = false;
        }
    });
    folderInputDiv.appendChild(folderInput);
    fileInputsContainer.appendChild(folderInputDiv);

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
        loopInput.checked = true; // Default to checked
        
     loopInput.addEventListener('change', function() {
    console.log(`Loop checkbox changed for input ${i}`);
    const file = audioBuffers[i]?.name;
    if (file) {
        // Get or create metadata
        let metadata = fileMetadata.get(file);
        if (!metadata) {
            metadata = { 
                bpm: 120, 
                key: 'Unknown', 
                isLoop: this.checked, 
                centerFreq: 0 
            };
        } else {
            metadata.isLoop = this.checked;
        }
        fileMetadata.set(file, metadata);
        
        // Update UI if available
        if (fileBpm) {
            fileBpm.textContent = `BPM: ${metadata.bpm}, Key: ${metadata.key}, Freq: ${metadata.centerFreq.toFixed(0)}Hz, Type: ${metadata.isLoop ? 'Loop' : 'One-Shot'}`;
        }
        console.log(`app.js: Loop set to ${metadata.isLoop} for ${file}`);
        
        // Sync loop-all checkbox state
        if (loopAllCheckbox) {
            const allChecked = Array.from(document.querySelectorAll('.loop-checkbox'))
                .every(cb => cb.checked);
            loopAllCheckbox.checked = allChecked;
            loopAllCheckbox.indeterminate = !allChecked && 
                Array.from(document.querySelectorAll('.loop-checkbox'))
                    .some(cb => cb.checked);
        }
    }
});

        input.addEventListener('change', () => {
            console.log(`File input ${input.id} changed`);
            if (input.files.length > 0) {
                console.log(`app.js: File selected for input ${input.id}: ${input.files[0].name}`);
                showStatus(`Selected file: ${input.files[0].name}`, 'info');
                fileName.textContent = input.files[0].name;
                processingQueue.push({ file: input.files[0], index: i });
                isAutoLoading = false;
                processQueue();
            } else {
                showStatus('No file selected.', 'info');
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
    console.log(`app.js: Created ${count} file inputs`);
}

async function processQueue() {
    if (isProcessing || processingQueue.length === 0) return;
    isProcessing = true;
    showStatus('Processing files...', 'info');
    try {
        console.log(`app.js: Processing ${processingQueue.length} files in queue`);
        let processedCount = 0;
        while (processingQueue.length > 0) {
            const { file, index } = processingQueue.shift();
            console.log(`Processing queue item: ${file.name} at index ${index}`);
            await processFile(file, index);
            processedCount++;
            console.log(`app.js: Processed ${processedCount}/${processedCount + processingQueue.length} files`);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        console.log(`app.js: Completed processing ${processedCount} files`);
        showStatus('File processing complete', 'success');
    } catch (error) {
        console.error('app.js: Error processing queue:', error);
        showStatus(`Error processing files: ${error.message}`, 'error');
    } finally {
        isProcessing = false;
        updateProcessButtonState();
        console.log('app.js: Processing queue complete');
    }
}

async function distributeFiles(files) {
    try {
        console.log(`app.js: Distributing ${files.length} files`, files.map(f => f.name));
        if (!files || files.length === 0) {
            console.error('app.js: No files provided');
            showStatus('No files provided.', 'error');
            isAutoLoading = false;
            return;
        }
        const fileInputs = fileInputsContainer.querySelectorAll('input[type="file"]:not(#folder-input)');
        if (!fileInputs.length) {
            console.error('app.js: No file input elements found');
            showStatus('No file inputs available.', 'error');
            isAutoLoading = false;
            return;
        }
        const validFiles = files.filter(file => file.type.startsWith('audio/'));
        if (!validFiles.length) {
            console.error('app.js: No valid audio files detected');
            showStatus('No valid audio files. Use WAV, MP3, or OGG.', 'error');
            isAutoLoading = false;
            return;
        }

        audioBuffers = new Array(trackCount).fill(null);
        fileMetadata.clear();
        fileInputs.forEach((input, i) => {
            const fileName = input.parentElement.querySelector('.file-name');
            const fileError = input.parentElement.querySelector('.file-error');
            const fileBpm = input.parentElement.querySelector('.file-bpm');
            if (fileName) fileName.textContent = '';
            if (fileError) fileError.textContent = '';
            if (fileBpm) fileBpm.textContent = '';
            input.value = '';
        });

        const selectedFiles = validFiles.slice(0, trackCount);
        console.log(`app.js: Selected ${selectedFiles.length} files:`, selectedFiles.map(f => f.name));

        selectedFiles.forEach((file, i) => {
            if (i < fileInputs.length) {
                console.log(`app.js: Queuing ${file.name} for track ${i}`);
                const fileName = fileInputs[i].parentElement.querySelector('.file-name');
                if (fileName) fileName.textContent = file.name;
                processingQueue.push({ file, index: i });
            }
        });
        console.log(`app.js: Queued ${processingQueue.length} files for processing`);
        await processQueue();
        showStatus(`${selectedFiles.length} file(s) queued for processing`, 'info');
    } catch (error) {
        console.error('app.js: Error distributing files:', error);
        showStatus(`Error loading files: ${error.message}`, 'error');
        isAutoLoading = false;
        updateProcessButtonState();
    }
}

function setupBlinkRateControls() {
    const bpmInput = document.getElementById('project-bpm-slider');
    const playbackRateInput = document.getElementById('playback-rate');
    
    if (bpmInput) {
        bpmInput.addEventListener('input', () => {
            if (isBlinkingActive) {
                stopNodeBlinking();
                startTempoSyncedBlinking();
            }
        });
    }
    
    if (playbackRateInput) {
        playbackRateInput.addEventListener('input', () => {
            if (isBlinkingActive) {
                stopNodeBlinking();
                startTempoSyncedBlinking();
            }
        });
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
                updateProcessButtonState();
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
                    mixedAudio.playbackRate = preservePitchInput.checked ? rate : 1.0;
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
            console.error('app.js: .upload-area not found');
            showStatus('Upload area not found.', 'error');
            return;
        }
        console.log('app.js: Binding drag-and-drop to', uploadArea);
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('app.js: Dragover event');
            uploadArea.style.background = 'rgba(123, 211, 247, 0.3)';
            showStatus('Drag files here...', 'info');
        });
        uploadArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('app.js: Dragleave event');
            uploadArea.style.background = '';
        });
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('app.js: Drop event', e.dataTransfer.files);
            uploadArea.style.background = '';
            const files = Array.from(e.dataTransfer.files || []);
            if (!files.length) {
                showStatus('No files dropped.', 'error');
                return;
            }
            showStatus(`Dropped ${files.length} file(s)`, 'info');
            isAutoLoading = false;
            distributeFiles(files);
        });
        uploadArea.addEventListener('click', () => {
            const input = fileInputsContainer.querySelector('input[type="file"]:not(#folder-input)');
            if (input) {
                console.log('app.js: Upload area clicked, triggering file input');
                input.click();
            }
        });
setupBlinkRateControls();
    } catch (error) {
        console.error('app.js: Error in setupEventListeners:', error);
        showStatus(`Error setting up event listeners: ${error.message}`, 'error');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('app.js: DOMContentLoaded');
    createFileInputs();
    setupEventListeners();
});
