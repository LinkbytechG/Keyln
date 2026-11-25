// The one place to set the repository URL. Every [data-github] link picks it up.
window.KEYLN_GITHUB = 'https://github.com/LinkbytechG/Keyln';

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-github]').forEach((a) => {
    a.href = window.KEYLN_GITHUB + (a.dataset.github || '');
  });
});
