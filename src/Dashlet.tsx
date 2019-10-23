import * as React from 'react';
import { withTranslation } from 'react-i18next';
import { Dashlet, PureComponentEx } from 'vortex-api';
import i18n from 'i18next';
import { Alert } from 'react-bootstrap';

export interface IGTA5DashletProps {
  t: i18n.TFunction;
}

class GTA5Dashlet extends PureComponentEx<IGTA5DashletProps, {}> {
  public render() {
    const { t } = this.props;
    return (
      <Dashlet
        title={t('Grand Theft Auto V')}
        className='dashlet-gta5'
      >
        <Alert bsStyle='warning'>
          {t('Vortex only starts the game in offline mode, using mods in online mode is against the games EULA '
            + 'and may lead to a ban! ')}
          {t('Please ensure you "Purge" mods before starting the game outside Vortex.')}
        </Alert>
      </Dashlet>
    );
  }
}

export default withTranslation(['common', 'gta5-support'])(GTA5Dashlet as any) as React.ComponentClass<{}>;
