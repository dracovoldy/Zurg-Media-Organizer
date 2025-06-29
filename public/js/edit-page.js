document.addEventListener('DOMContentLoaded', () => {
  // AJAX action handler for Parse, Update TMDB, Add to Library
  document.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', async function(e) {
      e.preventDefault();
      const url = btn.getAttribute('data-url');
      showDialog('Processing...', 'Please wait...');
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        if (!resp.ok) throw new Error('Request failed');
        const data = await resp.json();
        updateSummaryCard(data);
        showDialog('Success', 'Updated successfully');
      } catch (err) {
        showDialog('Error', err.message || 'Failed');
      }
    });
  });
});
