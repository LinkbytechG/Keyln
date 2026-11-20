// The one place to set the repository URL. Every [data-github] link picks it up.
// TODO: replace OWNER with the real GitHub account or organisation.
window.KEYLN_GITHUB = 'https://github.com/OWNER/Keyln';

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-github]').forEach((a) => {
    a.href = window.KEYLN_GITHUB + (a.dataset.github || '');
  });
});
