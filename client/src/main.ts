import 'leaflet/dist/leaflet.css';
import './styles/app.css';
import { loadSession, state } from './state';
import { flushMeshSave } from './transport/meshStore';
import { initRoomMenu } from './views/roomMenu';
import { enterMap, initMapView, toast } from './views/mapView';
import { shouldShowInstallGate, showInstallGate } from './views/installGate';

initRoomMenu();
initMapView();

// Sur mobile dans un navigateur (pas en PWA installée), on masque le site
// derrière une page d'installation ; sinon on démarre directement.
if (shouldShowInstallGate()) showInstallGate(startApp);
else startApp();

function startApp(): void {
  // Carte directe, avec ou sans salle. Une session en localStorage survit au
  // reload, à la mise en veille et à la fermeture/relance de la PWA : le socket
  // fait le rejoin (re-binding via sessionToken) ; sinon on démarre en solo.
  loadSession();
  enterMap();
}

// Une PWA mise en arrière-plan peut être tuée sans autre préavis : on écrit
// alors sans attendre l'échéance différée. `visibilitychange` est le seul
// événement fiable pour cela sur mobile — `beforeunload` n'est pas déclenché
// quand l'OS ferme l'application.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushMeshSave(state.orders);
});

registerServiceWorker();

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  void navigator.serviceWorker.register('/sw.js').then((reg) => {
    // Jamais de skip-waiting automatique sur une app tactique : on propose,
    // l'utilisateur décide quand recharger.
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Mise à jour disponible.', {
            label: 'Recharger',
            onClick: () => worker.postMessage('SKIP_WAITING'),
          });
        }
      });
    });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}
