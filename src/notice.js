// Confirmation page: send the confirmation straight away, so one click in the email is enough.
// Without JavaScript, the visitor presses the button instead.
const form = document.querySelector('form[data-autosubmit]');
if (form) {
  form.querySelector('button').disabled = true;
  form.submit();
}
