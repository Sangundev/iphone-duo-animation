export function requireElement(selector, within = document) {
  const found = within.querySelector(selector);
  if (!found) throw new Error(`Missing element "${selector}".`);
  return found;
}

export class Loader {
  constructor(selector) {
    this.element = requireElement(selector);
    this.label = requireElement('.loader-label', this.element);
    this.bar = requireElement('.loader-bar', this.element);
    this.shown = 0;
  }
  setProgress(fraction, message) {
    this.shown = Math.max(this.shown, Math.min(Math.max(fraction, 0), 1));
    const percent = Math.round(this.shown * 100);
    this.bar.style.transform = `scaleX(${this.shown})`;
    this.element.setAttribute('aria-valuenow', String(percent));
    if (message) this.label.textContent = `${message} ${percent}%`;
  }
  done() {
    this.setProgress(1);
    this.element.closest('.viewer')?.classList.add('is-ready');
    this.element.setAttribute('aria-busy', 'false');
  }
  fail(message) {
    this.element.classList.add('is-failed');
    this.label.textContent = message;
  }
}

export class Notice {
  constructor(selector) {
    this.element = requireElement(selector);
  }
  show(message, seconds) {
    this.element.textContent = message;
    this.element.hidden = false;
    if (seconds) {
      window.setTimeout(() => {
        this.element.hidden = true;
      }, seconds * 1000);
    }
  }
}

export class Uploader {
  constructor(buttonSelector, fieldSelector, resetSelector) {
    this.button = requireElement(buttonSelector);
    this.field = requireElement(fieldSelector);
    this.reset = requireElement(resetSelector);
  }
  setDisabled(disabled) {
    this.button.disabled = disabled;
  }
  setCustom(custom) {
    this.reset.hidden = !custom;
  }
  onReset(callback) {
    this.reset.addEventListener('click', () => {
      this.setCustom(false);
      callback();
    });
  }
  onChange(callback) {
    this.button.addEventListener('click', () => this.field.click());
    this.field.addEventListener('change', () => {
      const file = this.field.files?.[0];
      this.field.value = '';
      if (file) callback(file);
    });
  }
}