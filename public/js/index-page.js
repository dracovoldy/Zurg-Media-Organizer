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
      apiCall(endpoint, method);
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
