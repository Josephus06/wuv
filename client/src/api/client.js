import axios from 'axios';
import { Capacitor } from '@capacitor/core';
import { NATIVE_API_BASE } from '../config/company';
import { getBirCompanyId } from '../utils/birCompany';

// A Capacitor app has no same-origin server to be relative to -- it loads the bundled
// dist/ files from a local scheme (https://localhost on Android), so a relative '/api'
// would hit that local scheme instead of any real backend. Native builds point at the
// live production API instead; the web build (dev + browser deploy) is unaffected.
// The packaged mobile app has no dev-server proxy, so it needs an absolute API URL.
// Set VITE_NATIVE_API_BASE before building the Capacitor bundle.
const baseURL = Capacitor.isNativePlatform() ? `${NATIVE_API_BASE}/api` : '/api';
const api = axios.create({ baseURL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // BIR Reports work on one company's books at a time (utils/birCompany.js, BirCompanyPicker).
  const birCompanyId = getBirCompanyId();
  if (birCompanyId && /^\/?reports\/bir/.test(config.url || '') && !config.params?.companyId) {
    config.params = { ...(config.params || {}), companyId: birCompanyId };
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
