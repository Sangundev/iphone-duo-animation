import { createRail } from './ui/rail.js';
import { requireElement, Loader, Notice, Uploader } from './components.js';

const notice = new Notice('#notice');
const loader = new Loader('#loader');
const uploader = new Uploader('#upload', '#upload-file', '#reset-upload');

// The menu is plain DOM, so it renders straight away. Picks made while the model loads are remembered
// through `rail.current` and the device arrives on whichever highlight is chosen.
let onSelect = () => {};
const rail = createRail(
  requireElement('#highlight-list'),
  requireElement('#highlight-sheet'),
  requireElement('#previous-highlight'),
  requireElement('#next-highlight'),
  (highlight) => onSelect(highlight),
);

async function boot() {
  loader.setProgress(0.02, 'Loading 3D model');
  let experience;
  try {
    // three.js and the device code live in their own module so the page and menu never wait for them.
    experience = await import('./experience.js');
  } catch (error) {
    console.error(error);
    loader.fail('Could not load the viewer.');
    notice.show('The 3D viewer could not be loaded. Refresh the page to try again.');
    return;
  }
  await experience.start({
    host: requireElement('#stage'),
    rack: requireElement('#highlights'),
    rail,
    notice,
    loader,
    uploader,
    bindSelect(handler) {
      onSelect = handler;
    },
  });
}

void boot();