import express from 'express';
import { logger } from '@jmpm/shared';

const app = express();
const REGISTRY_API = process.env.REGISTRY_API_URL || 'http://localhost:4873';

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>jmpm Package Registry</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background-color: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  </style>
</head>
<body class="min-h-screen flex flex-col">
  <header class="border-b border-gray-800 bg-[#161b22] px-8 py-4 flex items-center justify-between">
    <div class="flex items-center space-x-3">
      <div class="w-8 h-8 rounded bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-white shadow-lg">J</div>
      <h1 class="text-xl font-bold tracking-tight text-white">jmpm <span class="text-xs px-2 py-0.5 rounded bg-indigo-900/60 text-indigo-300 border border-indigo-700/50">Registry</span></h1>
    </div>
    <div class="text-sm text-gray-400">
      Connected to: <code id="registryUrl" class="text-indigo-400 font-mono">${REGISTRY_API}</code>
    </div>
  </header>

  <main class="flex-1 max-w-5xl w-full mx-auto px-6 py-10">
    <div class="mb-10 text-center">
      <h2 class="text-3xl font-extrabold text-white mb-3">Discover Packages</h2>
      <p class="text-gray-400 max-w-xl mx-auto">Browse and explore packages published to your private jmpm & npm compatible registry.</p>
      
      <div class="mt-6 max-w-xl mx-auto relative">
        <input id="searchInput" type="text" placeholder="Search packages (e.g. math-utils, express)..." 
          class="w-full bg-[#161b22] border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors shadow-inner" />
      </div>
    </div>

    <div id="loading" class="text-center py-12 text-gray-400">Loading packages...</div>
    <div id="empty" class="hidden text-center py-12 text-gray-400">
      <div class="text-5xl mb-3">📦</div>
      <p class="text-lg font-medium text-gray-300">No packages found</p>
      <p class="text-sm text-gray-500 mt-1">Publish packages with <code class="bg-[#161b22] px-2 py-1 rounded text-indigo-300 font-mono">jmpm publish</code></p>
    </div>

    <div id="packageList" class="grid gap-4"></div>
  </main>

  <footer class="border-t border-gray-800 bg-[#161b22] py-4 text-center text-xs text-gray-500">
    Powered by jmpm / forgepm • Modern TypeScript Package Manager
  </footer>

  <script>
    const registryUrl = '${REGISTRY_API}';
    const packageList = document.getElementById('packageList');
    const loading = document.getElementById('loading');
    const empty = document.getElementById('empty');
    const searchInput = document.getElementById('searchInput');

    async function fetchPackages(query = '') {
      loading.classList.remove('hidden');
      empty.classList.add('hidden');
      packageList.innerHTML = '';

      try {
        const res = await fetch(registryUrl + '/-/v1/search?text=' + encodeURIComponent(query));
        const data = await res.json();
        loading.classList.add('hidden');

        if (!data.objects || data.objects.length === 0) {
          empty.classList.remove('hidden');
          return;
        }

        data.objects.forEach(item => {
          const pkg = item.package;
          const card = document.createElement('div');
          card.className = 'border border-gray-800 bg-[#161b22] hover:border-gray-700 rounded-lg p-5 transition-all shadow-sm';
          card.innerHTML = \`
            <div class="flex items-start justify-between">
              <div>
                <div class="flex items-center space-x-2">
                  <h3 class="text-lg font-semibold text-indigo-400 hover:underline cursor-pointer">\${pkg.name}</h3>
                  <span class="text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded font-mono">v\${pkg.version}</span>
                </div>
                <p class="text-sm text-gray-400 mt-1.5">\${pkg.description || 'No description provided.'}</p>
              </div>
              <div class="bg-black/40 border border-gray-800 rounded px-3 py-1.5 font-mono text-xs text-gray-300 select-all cursor-pointer hover:border-gray-600">
                jmpm add \${pkg.name}
              </div>
            </div>
            <div class="mt-4 pt-3 border-t border-gray-800/80 flex items-center justify-between text-xs text-gray-500">
              <span>Published: \${new Date(pkg.date).toLocaleDateString()}</span>
              <span class="text-indigo-400/80 hover:text-indigo-300">View Metadata &rarr;</span>
            </div>
          \`;
          packageList.appendChild(card);
        });
      } catch (err) {
        loading.classList.add('hidden');
        empty.classList.remove('hidden');
        empty.innerHTML = '<p class="text-red-400">Failed to connect to Registry API at ' + registryUrl + '</p>';
      }
    }

    searchInput.addEventListener('input', (e) => {
      fetchPackages(e.target.value);
    });

    fetchPackages();
  </script>
</body>
</html>`);
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  logger.success(`Registry Web Explorer running at http://localhost:${port}`);
});

