// Файл: public/sw-register.js
(function() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', async () => {
            try {
                const registrations = await navigator.serviceWorker.getRegistrations();
                
                for (let registration of registrations) {
                    if (registration.active && registration.active.scriptURL.includes('service-worker.js')) {
                        console.log('✅ Service Worker уже активен');
                        return;
                    }
                }
                
                const registration = await navigator.serviceWorker.register('/service-worker.js', {
                    scope: '/'
                });
                
                console.log('✅ Service Worker зарегистрирован:', registration.scope);
                
                await navigator.serviceWorker.ready;
                console.log('✅ Service Worker готов к работе');
                
                // Проверяем поддержку уведомлений
                if ('Notification' in window) {
                    if (Notification.permission === 'default') {
                        console.log('🔔 Уведомления: разрешение не запрошено');
                    } else if (Notification.permission === 'granted') {
                        console.log('🔔 Уведомления разрешены');
                    } else {
                        console.log('🔔 Уведомления запрещены');
                    }
                }
                
            } catch (err) {
                console.error('❌ Ошибка регистрации SW:', err);
            }
        });
    }
})();