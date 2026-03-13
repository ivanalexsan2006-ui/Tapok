const CACHE_NAME = 'tapok-v7';

self.addEventListener('install', (event) => {
    console.log('👷 Service Worker установлен');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('👷 Service Worker активирован');
    
    // Очищаем старые кэши
    event.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(keyList.map((key) => {
                if (key !== CACHE_NAME) {
                    console.log('🗑️ Удаляем старый кэш:', key);
                    return caches.delete(key);
                }
            }));
        })
    );
    
    event.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
    console.log('📩 Получено push-уведомление');
    
    let data = {};
    
    try {
        if (event.data) {
            data = event.data.json();
            console.log('📦 Данные уведомления:', data);
        }
    } catch (e) {
        console.error('❌ Ошибка парсинга push:', e);
        data = {
            title: '💬 Tapok',
            body: 'Новое сообщение',
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-192.png',
            data: { url: '/' }
        };
    }
    
    const options = {
        body: data.body || 'Новое сообщение в Tapok',
        icon: data.icon || '/icons/icon-192.png',
        badge: data.badge || '/icons/icon-192.png',
        vibrate: [200, 100, 200],
        data: data.data || { url: '/' },
        actions: data.actions || [
            {
                action: 'open',
                title: '📱 Открыть'
            },
            {
                action: 'close',
                title: '✕ Закрыть'
            }
        ],
        tag: data.tag || 'tapok',
        renotify: true,
        requireInteraction: false,
        silent: false,
        timestamp: Date.now()
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title || '💬 Tapok', options)
    );
});

self.addEventListener('notificationclick', function(event) {
    console.log('👆 Нажатие на уведомление, действие:', event.action);
    
    event.notification.close();
    
    if (event.action === 'close') {
        return;
    }
    
    const urlToOpen = event.notification.data?.url || '/';
    
    event.waitUntil(
        clients.matchAll({ 
            type: 'window', 
            includeUncontrolled: true 
        }).then((clientList) => {
            for (let client of clientList) {
                if (client.url.includes('/chat') && 'focus' in client) {
                    console.log('🔍 Фокус на существующем окне');
                    return client.focus();
                }
            }
            
            if (clientList.length > 0) {
                console.log('🔍 Используем другое окно');
                return clientList[0].navigate(urlToOpen).then(() => {
                    return clientList[0].focus();
                });
            }
            
            console.log('🆕 Открываем новое окно');
            return clients.openWindow(urlToOpen);
        })
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.url.includes('/api/')) {
        return;
    }
    
    event.respondWith(
        fetch(event.request)
            .then(response => {
                return response;
            })
            .catch(() => {
                return caches.match(event.request);
            })
    );
});
