import * as React from 'react';
import { withTranslation, WithTranslation } from 'react-i18next';
import { ComponentEx, Modal, FlexLayout } from 'vortex-api';
import { ListGroup, ListGroupItem, Table, Button, Panel, Alert } from 'react-bootstrap';
import Select from 'react-select';

export type IOptions = Array<{ key: string, options: string[] }>;

export interface IInstallerDialogState {
  options: IOptions;
  text: string;
  labelKey: string;
  labelChoices: string;
  callback: (err: Error, res: Array<{ key: string, choice: string }>) => void;
};

export interface IBaseProps {
  visible: boolean;
  onHide: () => void;
  state: IInstallerDialogState;
}

type IProps = IBaseProps & WithTranslation;

interface IInstallDialogState {
  choices: Array<{ key: string, choice: string }>;
}

class InstallDialog extends ComponentEx<IProps, IInstallDialogState> {
  constructor(props: IProps) {
    super(props);

    this.initState({
      choices: [],
    });
  }

  public componentWillReceiveProps(newProps: IProps) {
    if (this.props.state !== newProps.state) {
      this.nextState.choices = newProps.state.options.map(iter => ({ key: iter.key, choice: iter.options[0] }));
    }
  }

  public render(): JSX.Element {
    const { t, onHide } = this.props;
    const { callback, labelKey, labelChoices, options, text } = this.props.state;
    const { choices } = this.state;
    return (
      <Modal id='gta5-installer' show={callback !== undefined} onHide={onHide}>
        <Modal.Header>
          <h4>
            {t('GTA5 Mod Installer')}
          </h4>
        </Modal.Header>
        <Modal.Body>
          <FlexLayout type='column'>
            <FlexLayout.Fixed>
              <Alert bsStyle='info'>
                {t('Sorry, Vortex can\'t automatically figure out how to install this mod, please select manually.')}
                <br />
                {t(text)}
              </Alert>
            </FlexLayout.Fixed>
            <FlexLayout.Flex className='gta5-selection-container'>
              <Table>
                <thead>
                  <th>{t(labelKey)}</th>
                  <th>{t(labelChoices)}</th>
                </thead>
                <tbody>
                  {(options || []).map((opt, idx) => (
                    <tr key={idx.toString()}>
                      <td>{opt.key}</td>
                      <td>
                        <Select
                          className='select-compact'
                          options={opt.options.map(iter => ({ idx, value: iter, label: iter }))}
                          value={choices[idx].choice}
                          onChange={this.changeOption}
                          clearable={false}
                          autosize={false}
                          searchable={false}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </FlexLayout.Flex>
          </FlexLayout>
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={this.apply}>{t('Continue')}</Button>
        </Modal.Footer>
      </Modal>
    );
  }

  private apply = () => {
    this.props.state.callback(null, this.state.choices);
  }

  private changeOption = (choice: { value: string, label: string, idx: number }) => {
    this.nextState.choices[choice.idx].choice = choice.value;
  }
}

export default withTranslation(['common', 'gta5'])(InstallDialog as any);
