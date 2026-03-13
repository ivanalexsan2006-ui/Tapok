const CACHE_NAME = 'tapok-v1';

self.addEventListener('install', (event) => {
    console.log('👷 Service Worker установлен');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('👷 Service Worker активирован');
    event.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
    console.log('📩 Получено push-уведомление', event);
    
    let data = {};
    
    try {
        if (event.data) {
            data = event.data.json();
            console.log('📦 Данные уведомления:', data);
        }
    } catch (e) {
        console.error('❌ Ошибка парсинга push:', e);
        data = {
            title: 'Tapok',
            body: 'Новое сообщение',
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
                title: 'Открыть чат'
            }
        ],
        dir: 'auto',
        lang: 'ru',
        renotify: true,
        requireInteraction: true,
        silent: false,
        tag: data.data?.chatId ? `chat-${data.data.chatId}` : 'tapok',
        timestamp: Date.now()
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title || '💬 Tapok', options)
    );
});

self.addEventListener('notificationclick', function(event) {
    console.log('👆 Нажатие на уведомление:', event.action);
    
    event.notification.close();
    
    if (event.action === 'close') return;
    
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
            
            for (let client of clientList) {
                if ('focus' in client) {
                    console.log('🔍 Фокус на другом окне');
                    client.navigate(urlToOpen);
                    return client.focus();
                }
            }
            
            console.log('🆕 Открываем новое окно');
            return clients.openWindow(urlToOpen);
        })
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        fetch(event.request).catch(() => {
            return caches.match(event.request);
        })
    );
});
