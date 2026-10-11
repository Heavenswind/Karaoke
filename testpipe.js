// Usage: node testpipe.js [videoId] [languageHint]
//   node testpipe.js                     -- the default ja test song
//   node testpipe.js GZcOzPutkIg         -- let Whisper detect the language
const pipeline = require('./pipeline');
const videoId = process.argv[2] || '-vQAJ3CiLaY';
const langHint = process.argv[3] || (process.argv[2] ? null : 'ja');
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
console.log(`preparing ${videoId} (languageHint=${langHint || 'auto'})`);
pipeline.prepareVideo(videoId, langHint, (s) => console.log(`${el()}s  status: ${s}`))
  .then(r => {
      console.log(`${el()}s  DONE success=${r.success} error=${r.error || '-'}`);
      if (r.success) {
          console.log(`   lang=${r.language} model=${r.model} segments=${r.segments.length} dur=${r.duration}`);
          for (const s of r.segments.slice(0, 4)) {
              console.log(`   [${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text.slice(0, 40)}`);
          }
          const w = r.segments[0].words[0];
          console.log('   first word:', JSON.stringify(w));
      }
      console.log('   status():', JSON.stringify(pipeline.status()));
      pipeline.stopWorker();
      setTimeout(() => process.exit(0), 1500);
  })
  .catch(e => { console.error('THREW', e); process.exit(1); });
