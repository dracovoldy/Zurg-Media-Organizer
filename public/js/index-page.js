async function apiCall(endpoint, method = 'GET') {
  try {
    const response = await fetch(endpoint, {
      method,
      headers: {
        'Accept': 'application/json'
      }
    });
    const contentType = response.headers.get("Content-Type");
    if (contentType && contentType.indexOf("application/json") !== -1) {
      const result = await response.json();
      if (response.ok) {
        showDialog("success", result.message || response.statusText);
      } else {
        showDialog("error", result.error || response.statusText);
      }
    } else {
      const resultText = await response.text();
      if (response.ok) {
        showDialog("success", resultText);
      } else {
        showDialog("error", resultText);
      }
    }
  } catch (error) {
    showDialog("error", error.message);
  }
}

async function createLibrary() {
  const name = document.getElementById('newLibName').value.trim();
  const root = document.getElementById('newLibRoot').value.trim();
  const isDefault = document.getElementById('newLibDefault').checked;
  if (!name || !root) { showDialog('error', 'Name and root path required'); return; }
  try {
    const resp = await fetch('/libraries', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ name, rootPath: root, isDefault }) });
    const data = await resp.json();
    if (resp.ok) {
      showDialog('success', 'Library created');
      setTimeout(() => window.location.reload(), 800);
    } else {
      showDialog('error', data.error || 'Failed to create');
    }
  } catch (e) { showDialog('error', e.message); }
}

function showDialog(type, message) {
  const dialog = document.getElementById("api-dialog");
  const dialogTitle = document.getElementById("api-dialog-title");
  const dialogMessage = document.getElementById("api-dialog-message");
  dialogTitle.textContent = type === "success" ? "Success" : "Error";
  dialogMessage.textContent = message;
  dialog.style.display = "block";
}

function closeDialog() {
  document.getElementById("api-dialog").style.display = "none";
}

document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll('.btn-api').forEach(button => {
    button.addEventListener('click', function (e) {
      e.preventDefault();
      const endpoint = button.getAttribute('data-endpoint');
      const method = button.getAttribute('data-method') || 'GET';
        // If there is a library selector include its value as query param for relevant endpoints
        const libSelect = document.getElementById('libraryId');
        let finalEndpoint = endpoint;
        if (libSelect && (endpoint.includes('add-to-library') || endpoint.includes('update-all-tmdb') || endpoint.includes('add-to-library-mass'))) {
          const libId = libSelect.value;
          if (libId) {
            finalEndpoint = endpoint + (endpoint.includes('?') ? '&' : '?') + 'libraryId=' + encodeURIComponent(libId);
          }
        }
        apiCall(finalEndpoint, method);
    });
  });

  // Accordion for filter bar
  const filterToggle = document.getElementById('filter-toggle');
  const filterPanel = document.getElementById('filter-panel');
  if (filterToggle && filterPanel) {
    filterToggle.addEventListener('click', function () {
      const expanded = filterToggle.getAttribute('aria-expanded') === 'true';
      filterToggle.setAttribute('aria-expanded', !expanded);
      filterToggle.textContent = expanded ? 'Show Filters' : 'Hide Filters';
      filterPanel.style.display = expanded ? 'none' : 'block';
    });
  }
  // Directory name toggles files
  document.querySelectorAll('.dir-toggle').forEach(function (el) {
    el.addEventListener('click', function () {
      const targetId = el.getAttribute('data-target');
      const fileContainer = document.getElementById(targetId);
      const expanded = el.getAttribute('aria-expanded') === 'true';
      el.setAttribute('aria-expanded', !expanded);
      if (fileContainer) fileContainer.style.display = expanded ? 'none' : 'block';
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.click();
      }
    });
  });
});
