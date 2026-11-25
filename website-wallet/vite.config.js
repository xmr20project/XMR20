import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {operatorConfigurationVitePlugin} from '../build-tools/operator-configuration.mjs';

export default defineConfig({
 plugins:[operatorConfigurationVitePlugin(),react()],
 base:'/wallet/',
 // The standalone wallet always uses public wallet auth, regardless of shell env.
 define:{__XMR20_NATIVE_MARKET__:JSON.stringify(process.env.XMR20_OPERATOR_NATIVE_CANDIDATE==='1'),__XMR20_FAST_SEND__:JSON.stringify(process.env.XMR20_FAST_SEND==='1'),__XMR20_UNIVERSAL_LINK__:JSON.stringify(process.env.XMR20_UNIVERSAL_LINK==='1'),'import.meta.env.VITE_XMR20_WALLET_ONLY':JSON.stringify('1')},
 build:{outDir:'dist',emptyOutDir:true,rollupOptions:{input:'wallet.html'}},
 resolve:{dedupe:['react','react-dom'],alias:{buffer:'buffer'}}
});
