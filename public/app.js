fetch('/api/info')
  .then(r => r.json())
  .then(data => {
    document.getElementById('build-info').textContent =
      `commit: ${data.gitCommit} | built: ${data.buildTime}`;

    if (data.auth.user || data.auth.email || data.auth.groups || data.auth.name) {
      const rows = [
        ['Name',   data.auth.name],
        ['User',   data.auth.user],
        ['Email',  data.auth.email],
        ['Groups', data.auth.groups],
      ].filter(([, v]) => v);
      document.getElementById('auth-table').innerHTML =
        rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
      document.getElementById('auth-section').classList.remove('hidden');
    }

    if (data.cert.verify) {
      const rows = [['Verify', data.cert.verify], ['DN', data.cert.dn]];
      if (data.cert.pem) rows.push(['Cert', `<pre>${data.cert.pem}</pre>`]);
      document.getElementById('cert-table').innerHTML =
        rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
      document.getElementById('cert-section').classList.remove('hidden');
    }

    if (data.config.length > 0) {
      document.getElementById('config-content').innerHTML =
        data.config.map(f => {
          const text = Array.isArray(f.content)
            ? f.content.join('\n')
            : (typeof f.content === 'object' ? JSON.stringify(f.content, null, 2) : f.content);
          return `<h3>${f.name}</h3><pre>${text}</pre>`;
        }).join('');
      document.getElementById('config-section').classList.remove('hidden');
    }
  });
